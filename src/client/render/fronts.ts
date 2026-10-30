// Attack fronts: a troop count pill at each active front (your attacks yellow with an up arrow, attacks on you red
// with a down arrow, your allies' attacks on your enemies in the ally's colour at any zoom, other nations' fights when
// zoomed in). The pill sits on the most recent
// capture nearest to the attack's focus, learnt from the tile change feed (no map scans). The front itself glows
// on the map: captured tiles flash in the shader (tiles.ts).
import { areAllied } from '../../sim/diplomacy';
import { armyTotal } from '../../sim/economy';
import type { Attack, GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { css, formatCount, pill, type RGB } from './common';

/** An anchor older than this is replaced by any newer capture. */
const STALE_MS = 1500;

interface Anchor {
  tile: number;
  ms: number;
  d: number;
}

export class FrontLayer {
  private anchors = new Map<number, Anchor>();
  private byPair = new Map<number, Attack[]>();
  private tick = -1;
  private w = 1;
  private now = 0;
  /** this tick: attacks by your allies on nations you are fighting */
  private allied = new Set<number>();

  reset(w: number): void {
    this.anchors.clear();
    this.byPair.clear();
    this.tick = -1;
    this.w = w;
  }

  /** Call before the tile feed applies this frame's changes. */
  begin(state: GameState, nowMs: number): void {
    this.now = nowMs;
    if (state.tick === this.tick) return;
    this.tick = state.tick;
    this.byPair.clear();
    const live = new Set<number>();
    for (const a of state.attacks) {
      const key = a.attacker * 4096 + a.target;
      const list = this.byPair.get(key);
      if (list) list.push(a);
      else this.byPair.set(key, [a]);
      live.add(a.id);
    }
    for (const id of this.anchors.keys()) if (!live.has(id)) this.anchors.delete(id);
    this.allied.clear();
    const me = state.humanId;
    if (me > 0) {
      const enemies = new Set<number>();
      for (const a of state.attacks) {
        if (a.attacker === me && a.target > 0) enemies.add(a.target);
        else if (a.target === me && a.attacker > 0) enemies.add(a.attacker);
      }
      if (enemies.size) for (const a of state.attacks) if (enemies.has(a.target) && a.attacker !== me && areAllied(state, me, a.attacker)) this.allied.add(a.id);
    }
  }

  /** Tile feed listener: a tile went from `oldOwner` to `newOwner`. */
  readonly onChange = (tile: number, oldOwner: number, newOwner: number): void => {
    const list = this.byPair.get(newOwner * 4096 + oldOwner);
    if (!list) return;
    const w = this.w;
    const x = tile % w;
    const y = (tile / w) | 0;
    for (const a of list) {
      const dx = x - (a.focusTile % w);
      const dy = y - ((a.focusTile / w) | 0);
      const d = dx * dx + dy * dy;
      const cur = this.anchors.get(a.id);
      if (!cur || this.now - cur.ms > STALE_MS || d <= cur.d) this.anchors.set(a.id, { tile, ms: this.now, d });
    }
  };

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, humanId: number, colors: readonly RGB[]): void {
    const me = humanId;
    const z = cam.zoom;
    const w = this.w;
    for (const a of state.attacks) {
      const mine = me > 0 && a.attacker === me;
      const incoming = me > 0 && a.target === me;
      const ally = this.allied.has(a.id);
      if (!mine && !incoming && !ally && z < 6) continue;
      const anchor = this.anchors.get(a.id);
      const tile = anchor ? anchor.tile : a.focusTile;
      if (tile < 0) continue;
      const s = cam.tileToScreen((tile % w) + 0.5, ((tile / w) | 0) + 0.5);
      if (s.x < -40 || s.y < -40 || s.x > cam.viewW + 40 || s.y > cam.viewH + 40) continue;
      const edge = mine ? '#ffe98a' : incoming ? '#ff6b5e' : css(colors[a.attacker] ?? [200, 200, 200]);
      pill(ctx, s.x, s.y - Math.max(12, z * 0.9), formatCount(armyTotal(a.troops)), edge, mine || ally ? 'up' : incoming ? 'down' : 'none');
      if (mine && a.focusTile >= 0) {
        const f = cam.tileToScreen((a.focusTile % w) + 0.5, ((a.focusTile / w) | 0) + 0.5);
        ctx.beginPath();
        ctx.arc(f.x, f.y, Math.max(4, z * 0.6), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}
