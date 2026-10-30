// Screen-space overlays: effect radius rings, capital stars, missile / bomber target reticles, explosions,
// floating texts, the hovered tile, the selection and target-mode previews (build ghost, strike circles, routes).
import { buildingAt } from '../../sim/buildings';
import { ATOM_CORE_RADIUS, ATOM_RADIUS, BARRAGE_DELAY, BARRAGE_RADIUS, BOMBER_RADIUS, BUILDINGS, FORT_RADIUS_TECH, ROCKET_RADIUS, TICKS_PER_SECOND, UNITS } from '../../sim/config';
import { canBarrage } from '../../sim/barrage';
import { paradropRange } from '../../sim/units';
import { hasTech } from '../../sim/tech';
import { isTribe } from '../../sim/types';
import type { BuildingType, Effect, GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { drawMarker, type BuildingIconId } from '../icons';
import type { Snap } from '../placement';
import { FLOATER_MS, type UiState } from '../uiState';
import { clamp, css, dashedLine, haloText, MAP_LABEL_FAMILY, MAP_NUM_FAMILY, mix, pill, setTracking, type RGB } from './common';
import type { UnitLayer } from './units';
import { markerSize } from './buildings';

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
  private barrageKey = '';
  private barrageOk = false;

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
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = strong ? 2 : 1;
    ctx.strokeStyle = css(color, strong ? 0.9 : 0.45);
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
        ctx.lineWidth = own ? 2.5 : 1.5;
        ctx.strokeStyle = own ? `rgba(255,255,255,${0.55 + 0.4 * pulse})` : css(p.color, tribe ? 0.45 : 0.5 + 0.4 * pulse);
        ctx.stroke();
      }
      if (p.id === me && !spawn) {
        // your own capital: a white ring around the star, so it stands out from the others
        ctx.beginPath();
        ctx.arc(sx, sy, R * 1.45, 0, Math.PI * 2);
        ctx.lineWidth = 2;
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
    const r = Math.max(size * 0.75, 14) + 6 * pulse;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255,255,255,${0.6 + 0.4 * pulse})`;
    ctx.stroke();
    ctx.font = `600 12px ${MAP_LABEL_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    setTracking(ctx, 1.4);
    haloText(ctx, 'YOU', s.x + 0.7, s.y - r - 3, '#ffffff', 12);
    setTracking(ctx, 0);
  }

  /** Target reticles: red with a countdown for missiles / bombers flying at you, a quieter white one for yours. */
  telegraphs(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, units: UnitLayer, frac: number, me: number, nowMs: number): void {
    if (me <= 0 || state.units.length === 0) return;
    const z = cam.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 120);
    const live = new Set<number>();
    for (const u of state.units) {
      const kind = u.type;
      if (kind !== 'rocket' && kind !== 'atomBomb' && !((kind === 'bomber' || kind === 'transportPlane') && u.state === 0)) continue;
      const own = u.owner === me;
      const atMe = !own && state.map.owner[u.target] === me;
      if (!own && !atMe) continue;
      live.add(u.id);
      const tx = (u.target % this.w) + 0.5;
      const ty = ((u.target / this.w) | 0) + 0.5;
      const p = units.pos(u, frac);
      const ux = p.x + 0.5;
      const uy = p.y + 0.5;
      const dist = Math.sqrt((tx - ux) * (tx - ux) + (ty - uy) * (ty - uy));
      const eta = dist / Math.max(0.1, UNITS[kind].speed);
      let eta0 = this.etas.get(u.id);
      if (eta0 === undefined || eta0 < eta) {
        eta0 = Math.max(eta, 0.1);
        this.etas.set(u.id, eta0);
      }
      const s = cam.tileToScreen(tx, ty);
      const blast = kind === 'atomBomb' ? ATOM_RADIUS : kind === 'rocket' ? ROCKET_RADIUS : kind === 'transportPlane' ? 2.5 : BOMBER_RADIUS;
      const R = Math.max(14, blast * z);
      if (s.x < -R - 20 || s.y < -R - 20 || s.x > cam.viewW + R + 20 || s.y > cam.viewH + R + 20) continue;
      const col = atMe ? '255,70,55' : '255,255,255';
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col},${atMe ? 0.1 + 0.08 * pulse : 0.06})`;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = `rgba(${col},${atMe ? 0.55 + 0.4 * pulse : 0.55})`;
      ctx.stroke();
      ctx.setLineDash([]);
      const c = Math.min(R * 0.45, 12);
      ctx.beginPath();
      ctx.moveTo(s.x - c, s.y);
      ctx.lineTo(s.x + c, s.y);
      ctx.moveTo(s.x, s.y - c);
      ctx.lineTo(s.x, s.y + c);
      ctx.lineWidth = 2;
      ctx.stroke();
      const left = clamp(eta / eta0, 0, 1);
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.min(R, 22) * 0.75 + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(${col},0.95)`;
      ctx.stroke();
      if (atMe || z >= 2) {
        const label = `${eta < 9.95 ? eta.toFixed(1) : Math.round(eta)}s`;
        ctx.font = `500 12px ${MAP_NUM_FAMILY}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const lx = s.x + Math.min(R, 22) * 0.75 + 11;
        haloText(ctx, label, lx, s.y, atMe ? '#ffb3aa' : '#ffffff', 12);
      }
    }
    for (const id of this.etas.keys()) if (!live.has(id)) this.etas.delete(id);
  }

  /**
   * Artillery barrages in flight: a warning disc with a countdown where the shells will land (red when it is your
   * land, amber when they are your guns, grey for others) and shells arcing in over the last second.
   */
  barrages(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, frac: number, me: number, nowMs: number): void {
    const list = state.barrages;
    if (!list || list.length === 0) return;
    const z = cam.zoom;
    const now = state.tick + frac;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 110);
    for (const b of list) {
      const s = cam.tileToScreen((b.tile % this.w) + 0.5, ((b.tile / this.w) | 0) + 0.5);
      const R = Math.max(18, BARRAGE_RADIUS * z);
      if (s.x < -R - 40 || s.y < -R - 40 || s.x > cam.viewW + R + 40 || s.y > cam.viewH + R + 40) continue;
      const atMe = me > 0 && b.owner !== me && b.target === me;
      const mine = b.owner === me;
      const col = atMe ? '226,72,52' : mine ? '214,170,60' : '200,200,200';
      const left = clamp((b.hitTick - now) / (BARRAGE_DELAY * TICKS_PER_SECOND), 0, 1);
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col},${atMe ? 0.12 + 0.1 * pulse : 0.08})`;
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(${col},${atMe ? 0.6 + 0.35 * pulse : 0.7})`;
      ctx.stroke();
      ctx.setLineDash([]);
      // countdown arc
      ctx.beginPath();
      ctx.arc(s.x, s.y, R + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `rgba(${col},0.95)`;
      ctx.stroke();
      // shells: streaks coming down from the upper left onto points of the disc
      const p = 1 - left;
      for (let k = 0; k < 5; k++) {
        const a = (k * 2.4 + b.id) % (Math.PI * 2);
        const rr = R * (0.2 + 0.7 * (((k * 53 + b.id) % 10) / 10));
        const tx = s.x + Math.cos(a) * rr;
        const ty = s.y + Math.sin(a) * rr;
        const q = clamp(p * 1.25 - k * 0.06, 0, 1);
        if (q <= 0) continue;
        const sx = tx - (1 - q) * (60 + R);
        const sy = ty - (1 - q) * (90 + R) + (1 - q) * (1 - q) * 30;
        ctx.beginPath();
        ctx.moveTo(sx - 7, sy - 10);
        ctx.lineTo(sx, sy);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,236,190,0.9)';
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
    switch (e.kind) {
      case 'explosion': {
        const r = Math.max(6, R) * (0.3 + 0.7 * t);
        ctx.globalAlpha = 1 - t;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,150,50,0.55)';
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
      ctx.lineWidth = 2;
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
      case 'bomb':
        lineFrom(mode.airfield, 'rgba(255,255,255,0.7)');
        circle(BOMBER_RADIUS, 'rgba(255,120,60,0.95)', 'rgba(255,120,60,0.18)');
        break;
      case 'missile':
        lineFrom(mode.silo, 'rgba(255,255,255,0.7)');
        if (mode.missile === 'atomBomb') {
          circle(ATOM_RADIUS, 'rgba(255,200,60,0.95)', 'rgba(255,200,60,0.12)');
          circle(ATOM_CORE_RADIUS, 'rgba(255,90,40,0.95)', 'rgba(255,90,40,0.18)');
        } else {
          circle(ROCKET_RADIUS, 'rgba(255,90,60,0.95)', 'rgba(255,90,60,0.2)');
        }
        break;
      case 'paradrop': {
        // the reach of each of your airfields, the drop disc and the route from the airfield that would fly
        let best = -1;
        let bestD = Infinity;
        for (const b of state.buildings.values()) {
          if (b.owner !== state.humanId || b.type !== 'airfield' || b.buildLeft > 0) continue;
          if (mode.airfield >= 0 && b.tile !== mode.airfield) continue;
          const range = paradropRange(b);
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
        if (this.barrageKey !== `${hover}|${state.tick >> 2}`) {
          this.barrageKey = `${hover}|${state.tick >> 2}`;
          this.barrageOk = canBarrage(state, state.humanId, hover).ok;
        }
        const ok = this.barrageOk;
        circle(BARRAGE_RADIUS, ok ? 'rgba(214,170,60,0.95)' : 'rgba(226,72,52,0.95)', ok ? 'rgba(214,170,60,0.16)' : 'rgba(226,72,52,0.12)');
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
