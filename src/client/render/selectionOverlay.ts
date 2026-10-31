// What the unit selection and the unit orders draw on the map (client/selection.ts holds the logic):
//   - the Shift+drag selection box, and a thin brass outline on the buildings it selected (ui.buildingSel)
//   - the warship placement mode: the water where a warship can appear, shaded, and a ring / cross at the cursor
//   - the tank division build mode: rings on your factories
//   - the spearhead preview: a translucent arrow along spearheadPreview's path, solid as deep as it is expected to
//     get and dashed beyond, with the expected depth and the first warning at its head
// Cheap: the shaded area is a small offscreen canvas (one pixel per tile) rebuilt about once a second.
import { buildingsOf } from '../../sim/buildings';
import type { GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { activeBuildings, previewFor, SPEARHEAD_CONFIRM_MS, splitSelection, warshipSpawnArea, warshipSpawnCheck } from '../selection';
import { FAR_ZOOM, markerSize } from './buildings';
import type { UiState } from '../uiState';
import { MAP_NUM_FAMILY } from './common';
import { pocketPreview } from '../pillars';

const AREA_MS = 1000;
const BRASS = '#e3c04e';
const RED = '#ff6b5e';

export class SelectionOverlay {
  private area: HTMLCanvasElement | null = null;
  private areaBox: { x0: number; y0: number; w: number; h: number } | null = null;
  private areaAt = -Infinity;
  private areaKey = '';

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, nowMs: number): void {
    const me = state.humanId;
    if (me <= 0 || state.phase !== 'playing') return;
    if (ui.mode.kind === 'spawnWarship') this.spawnArea(ctx, state, cam, ui, nowMs);
    else this.areaKey = '';
    if (ui.mode.kind === 'buildTankDivision') this.factories(ctx, state, cam);
    if (ui.mode.kind === 'none' && ui.selection.length) this.spearhead(ctx, state, cam, ui, nowMs);
    if (ui.mode.kind === 'adminTile' && ui.mode.brush && ui.hoverTile >= 0) this.brush(ctx, state, cam, ui.hoverTile, ui.mode.radius ?? 0);
    if (ui.buildingSel.ids.length) this.buildingOutlines(ctx, state, cam, ui);
    const b = ui.selectBox;
    if (b) {
      const x = Math.min(b.x0, b.x1);
      const y = Math.min(b.y0, b.y1);
      const w = Math.abs(b.x1 - b.x0);
      const h = Math.abs(b.y1 - b.y0);
      ctx.fillStyle = 'rgba(227,192,78,0.08)';
      ctx.fillRect(x, y, w, h);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = BRASS;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }
  }

  /** Selected buildings (the Shift+drag box): a thin rounded outline just outside each marker's plate. */
  private buildingOutlines(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState): void {
    const list = activeBuildings(state, state.humanId, ui.buildingSel);
    if (!list.length) return;
    const w = state.map.width;
    const z = cam.zoom;
    const far = z < FAR_ZOOM;
    const base = far ? Math.max(5, z * 2.2) : markerSize(z);
    ctx.save();
    ctx.lineWidth = far ? 1 : 1.5;
    ctx.strokeStyle = 'rgba(227,192,78,0.9)';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 2;
    ctx.beginPath();
    for (const b of list) {
      const c = cam.tileToScreen((b.tile % w) + 0.5, ((b.tile / w) | 0) + 0.5);
      const size = !far && b.type === 'city' ? base * 1.18 : base;
      const r = far ? size / 2 + 1 : size / 2 + Math.min(3, Math.max(1.5, size * 0.09)) + 3;
      if (c.x < -r || c.y < -r || c.x > cam.viewW + r || c.y > cam.viewH + r) continue;
      ctx.roundRect(c.x - r, c.y - r, r * 2, r * 2, far ? 1 : r * 0.45);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Brush outline of the owner console's paint tool. */
  private brush(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, tile: number, r: number): void {
    const w = state.map.width;
    const c = cam.tileToScreen((tile % w) + 0.5, ((tile / w) | 0) + 0.5);
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(4, (r + 0.5) * cam.zoom), 0, Math.PI * 2);
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private spawnArea(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, nowMs: number): void {
    const me = state.humanId;
    const key = `${me}:${state.map.width}`;
    if (key !== this.areaKey || nowMs - this.areaAt > AREA_MS) {
      this.areaKey = key;
      this.areaAt = nowMs;
      this.buildArea(state, me);
    }
    const z = cam.zoom;
    if (this.area && this.areaBox) {
      const o = cam.tileToScreen(this.areaBox.x0, this.areaBox.y0);
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.area, o.x, o.y, this.areaBox.w * z, this.areaBox.h * z);
      ctx.imageSmoothingEnabled = prev;
    }
    const t = ui.hoverTile;
    if (t < 0 || t >= state.map.owner.length) return;
    const w = state.map.width;
    const c = cam.tileToScreen((t % w) + 0.5, ((t / w) | 0) + 0.5);
    const ok = warshipSpawnCheck(state, me, t).ok;
    const r = Math.max(7, z * 1.2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ok ? BRASS : RED;
    ctx.beginPath();
    if (ok) {
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    } else {
      ctx.moveTo(c.x - r * 0.6, c.y - r * 0.6);
      ctx.lineTo(c.x + r * 0.6, c.y + r * 0.6);
      ctx.moveTo(c.x + r * 0.6, c.y - r * 0.6);
      ctx.lineTo(c.x - r * 0.6, c.y + r * 0.6);
    }
    ctx.stroke();
  }

  private buildArea(state: GameState, me: number): void {
    const a = warshipSpawnArea(state, me);
    if (!a || typeof document === 'undefined') {
      this.area = null;
      this.areaBox = null;
      return;
    }
    const cv = this.area ?? document.createElement('canvas');
    cv.width = a.w;
    cv.height = a.h;
    const c2 = cv.getContext('2d');
    if (!c2) return;
    const img = c2.createImageData(a.w, a.h);
    for (let k = 0; k < a.mask.length; k++) {
      if (!a.mask[k]) continue;
      img.data[k * 4] = 120;
      img.data[k * 4 + 1] = 190;
      img.data[k * 4 + 2] = 255;
      img.data[k * 4 + 3] = 70;
    }
    c2.putImageData(img, 0, 0);
    this.area = cv;
    this.areaBox = { x0: a.x0, y0: a.y0, w: a.w, h: a.h };
  }

  private factories(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera): void {
    const w = state.map.width;
    const r = Math.max(9, cam.zoom * 1.6);
    ctx.beginPath();
    for (const b of buildingsOf(state, state.humanId, 'factory')) {
      if (b.buildLeft > 0) continue;
      const c = cam.tileToScreen((b.tile % w) + 0.5, ((b.tile / w) | 0) + 0.5);
      if (c.x < -r || c.y < -r || c.x > cam.viewW + r || c.y > cam.viewH + r) continue;
      ctx.moveTo(c.x + r, c.y);
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    }
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = BRASS;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** The spearhead arrow: for the waiting (clicked once) target, else the hovered foreign tile. */
  private spearhead(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, nowMs: number): void {
    const me = state.humanId;
    if (!splitSelection(state, me, ui.selection).tanks.length) return;
    const pend = ui.pendingSpearhead && nowMs - ui.pendingSpearhead.at < SPEARHEAD_CONFIRM_MS ? ui.pendingSpearhead.tile : -1;
    const tile = pend >= 0 ? pend : ui.hoverTile;
    const p = tile >= 0 ? previewFor(state, me, ui.selection, tile) : null;
    if (!p || p.reason || p.launch < 0) return;
    const w = state.map.width;
    const at = (t: number) => cam.tileToScreen((t % w) + 0.5, ((t / w) | 0) + 0.5);
    const pts = [at(p.launch), ...p.path.map(at)];
    if (pts.length < 2) return;
    const deep = Math.min(pts.length - 1, Math.max(1, p.expectedDepth));
    const alpha = pend >= 0 ? 0.55 : 0.32;
    // encirclement: the pocket the line would cut off, hatched in brass (pillars.pocketPreview)
    const pocket = pocketPreview(state, me, p);
    if (pocket) {
      const z = cam.zoom;
      ctx.fillStyle = `rgba(227,192,78,${pend >= 0 ? 0.26 : 0.16})`;
      for (const t of pocket.tiles) {
        const q = cam.tileToScreen(t % w, (t / w) | 0);
        if (q.x < -z || q.y < -z || q.x > cam.viewW || q.y > cam.viewH) continue;
        ctx.fillRect(q.x, q.y, z + 0.5, z + 0.5);
      }
    }
    const width = Math.max(5, Math.min(16, cam.zoom * 2.2));
    // solid part: as deep as it is expected to get
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k <= deep; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(227,192,78,${alpha})`;
    ctx.stroke();
    // dashed rest of the line
    if (deep < pts.length - 1) {
      ctx.beginPath();
      ctx.moveTo(pts[deep].x, pts[deep].y);
      for (let k = deep + 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(227,192,78,${alpha + 0.15})`;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // arrow head at the expected depth
    const a = pts[Math.max(0, deep - 1)];
    const b = pts[deep];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const hs = width * 1.3;
    ctx.beginPath();
    ctx.moveTo(b.x + Math.cos(ang) * hs, b.y + Math.sin(ang) * hs);
    ctx.lineTo(b.x + Math.cos(ang + 2.4) * hs, b.y + Math.sin(ang + 2.4) * hs);
    ctx.lineTo(b.x + Math.cos(ang - 2.4) * hs, b.y + Math.sin(ang - 2.4) * hs);
    ctx.closePath();
    ctx.fillStyle = `rgba(227,192,78,${Math.min(0.9, alpha + 0.25)})`;
    ctx.fill();
    // label at the head
    const label = `~${p.expectedDepth} tiles`;
    const warn = p.warnings[0] ?? '';
    ctx.font = `600 11px ${MAP_NUM_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const lines = [label];
    if (pocket) lines.push(`encircles ~${pocket.tiles.length} tiles`);
    if (warn) lines.push(warn);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
    const th = lines.length * 14 + 4;
    // keep the label on screen: flip it to the left of the head near the right edge, nudge it down / up at the top / bottom
    let lx = b.x + hs + 6;
    if (lx - 5 + tw > cam.viewW - 4) lx = Math.max(9, b.x - hs - 6 - tw + 5);
    const ly = Math.max(th / 2 + 100, Math.min(cam.viewH - th / 2 - 80, b.y)); // below the top cluster and its toasts, above the command bar
    ctx.fillStyle = 'rgba(10,13,21,0.82)';
    ctx.fillRect(lx - 5, ly - th / 2, tw, th);
    lines.forEach((l, k) => {
      ctx.fillStyle = k === 0 || (pocket && k === 1) ? BRASS : '#f0b07a';
      ctx.fillText(l, lx, ly - th / 2 + 9 + k * 14);
    });
  }
}
