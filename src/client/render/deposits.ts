// Resource deposits on the map: small coloured markers (oil = black drop, iron = grey rocks, fertile = wheat ear)
// without a plate. From DEPOSIT_ZOOM on one marker per field (nearby clusters merged, bigger fields only), from
// CLUSTER_ZOOM on one per 8-connected cluster; with the resource overlay on, fields at any zoom (merged on a coarser
// grid when zoomed far out). Deposits on
// other nations' land are drawn faded. The tiles themselves are marked by the map shader up close.
import type { GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { drawMarker, type ResourceIconId } from '../icons';
import { clamp, type View } from './common';
import { buildDeposits, type DepositCluster } from './terrain';

export const DEPOSIT_ZOOM = 4;
export const CLUSTER_ZOOM = 14;
const CELL = 32;
const IDS: readonly (ResourceIconId | null)[] = [null, 'iron', 'oil', 'fertile'];

class Grid {
  gw = 0;
  cells: DepositCluster[][] = [];
  constructor(list: DepositCluster[], w: number, h: number) {
    this.gw = Math.ceil(w / CELL);
    const gh = Math.ceil(h / CELL);
    this.cells = Array.from({ length: this.gw * gh }, () => []);
    for (const c of list) this.cells[Math.min(gh - 1, (c.y / CELL) | 0) * this.gw + Math.min(this.gw - 1, (c.x / CELL) | 0)].push(c);
  }
}

export class DepositLayer {
  private near: Grid | null = null;
  private far: Grid | null = null;
  private farther: Grid | null = null;
  private gh = 0;
  drawn = 0;

  setGame(state: GameState): void {
    const { width: w, height: h } = state.map;
    const d = buildDeposits(state.map);
    this.near = new Grid(d.near, w, h);
    this.far = new Grid(d.far, w, h);
    this.farther = new Grid(buildDeposits(state.map, 40).far, w, h);
    this.gh = Math.ceil(h / CELL);
  }

  /**
   * `focus` = the resource the player is placing a building for (mine: iron, oil well: oil, farm: fertile), 0 = none.
   * Fertile land is common, so its markers only show up close, with the overlay, or while placing a farm.
   */
  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, v: View, overlay: boolean, humanId: number, focus: number, dpr: number): void {
    this.drawn = 0;
    const z = cam.zoom;
    if (z < DEPOSIT_ZOOM && !overlay && focus === 0) return;
    const near = z >= CLUSTER_ZOOM;
    const grid = near ? this.near : z < 2 ? this.farther : this.far;
    if (!grid) return;
    const size = near ? clamp(6 + z * 0.9, 14, 26) : clamp(8 + z * 1.4, 11, 18);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const pad = size / z + 1;
    const cx0 = Math.max(0, Math.floor((v.x0 - pad) / CELL));
    const cy0 = Math.max(0, Math.floor((v.y0 - pad) / CELL));
    const cx1 = Math.min(grid.gw - 1, Math.floor((v.x1 + pad) / CELL));
    const cy1 = Math.min(this.gh - 1, Math.floor((v.y1 + pad) / CELL));
    const { building, owner } = state.map;
    // Zoomed out only the bigger fields (the overlay shows them all): keeps the view calm.
    const minTiles = near ? 1 : z < 2 ? 10 : overlay || focus !== 0 ? 3 : 8;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = grid.cells[cy * grid.gw + cx];
        for (let k = 0; k < list.length; k++) {
          const c = list[k];
          if (c.x < v.x0 - pad || c.x >= v.x1 + pad || c.y < v.y0 - pad || c.y >= v.y1 + pad) continue;
          if (c.tiles < minTiles || building[c.tile] !== 0) continue;
          const id = IDS[c.res];
          if (!id) continue;
          if (c.res === 3 && !overlay && focus !== 3 && z < CLUSTER_ZOOM) continue;
          const o = owner[c.tile];
          const foreign = o !== 0 && o !== humanId && humanId > 0;
          // Inside territory (yours or not) only the bigger fields get a marker unless you look for them, so owned
          // land doesn't fill up with drops and rocks up close.
          if (o !== 0 && !overlay && focus === 0 && c.tiles < (near ? 4 : 10)) continue;
          const dim = (foreign && !overlay) || (focus !== 0 && focus !== c.res);
          const inside = o !== 0 && !overlay && focus === 0;
          drawMarker(ctx, id, ox + c.x * z, oy + c.y * z, focus === c.res ? size * 1.2 : inside ? size * 0.85 : size, { dpr, alpha: dim ? 0.35 : inside ? 0.75 : 0.95 });
          this.drawn++;
        }
      }
    }
  }
}
