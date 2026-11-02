// Trench feed: the renderer's mirror of each tile's trench level (0..4, one byte per tile, uploaded as an R8 texture).
//
// Fed from the sim's trench change feed (trench.ts drainTrenchChanges: tiles whose LEVEL changed this tick), so a
// frame costs nothing while borders are quiet. Changed tiles mark 64 x 64 blocks dirty like the tile feed, and the
// GPU (or Canvas2D) layer re-uploads only those. A full rebuild on a new game, on overflow and whenever the tile feed
// rebuilds (rejoin catch-up). A state without trenches (hand-built test states) costs nothing.
import type { GameState } from '../../sim/types';
import { drainTrenchChanges, hasTrenches, trenchLevel, trenchLevelReader } from '../trench';
import { BLOCK, BLOCK_SHIFT } from './tiles';

/** A state without trenches is checked again this often (ms): a snapshot catch-up can bring them. */
const RECHECK_MS = 2000;

export class TrenchFeed {
  w = 0;
  h = 0;
  n = 0;
  bx = 0;
  by = 0;
  state: GameState | null = null;
  /** trench level per tile (0..4) */
  level = new Uint8Array(0);
  dirty = new Uint8Array(0);
  dirtyList: number[] = [];
  /** any tile dug at all (the shader and the 2D layer skip trench work while false) */
  any = false;
  private on = false;
  private lastScan = -Infinity;
  private lastGen = -1;

  reset(state: GameState, tileGen: number): void {
    this.state = state;
    this.w = state.map.width;
    this.h = state.map.height;
    this.n = this.w * this.h;
    this.bx = (this.w + BLOCK - 1) >> BLOCK_SHIFT;
    this.by = (this.h + BLOCK - 1) >> BLOCK_SHIFT;
    this.level = new Uint8Array(this.n);
    this.dirty = new Uint8Array(this.bx * this.by);
    this.dirtyList.length = 0;
    this.any = false;
    this.on = hasTrenches(state);
    this.lastScan = -Infinity;
    this.lastGen = tileGen;
    if (this.on) {
      drainTrenchChanges(state); // everything so far is in the full rebuild
      this.full();
    }
  }

  /** Rebuilds the mirror from the state; marks the blocks that changed dirty. */
  full(): void {
    const s = this.state;
    if (!s || !this.on) return;
    const lv = this.level;
    const read = trenchLevelReader(s);
    let any = false;
    for (let i = 0; i < this.n; i++) {
      const v = read(i);
      if (v !== 0) any = true;
      if (v !== lv[i]) {
        lv[i] = v;
        this.markDirty(i);
      }
    }
    this.any = any;
  }

  /** This frame's changes. `tileGen` = the tile feed's fullGen (a rebuild there rebuilds here too). */
  update(nowMs: number, tileGen: number): void {
    const s = this.state;
    if (!s) return;
    if (!this.on) {
      // trenches can appear later on a state (a snapshot catch-up): look again now and then
      if (nowMs - this.lastScan < RECHECK_MS) return;
      this.lastScan = nowMs;
      this.on = hasTrenches(s);
      if (!this.on) return;
    }
    if (tileGen !== this.lastGen) {
      this.lastGen = tileGen;
      drainTrenchChanges(s);
      this.full();
      return;
    }
    const ch = drainTrenchChanges(s);
    if (ch.overflow) {
      this.full();
      return;
    }
    const lv = this.level;
    for (let k = 0; k < ch.count; k++) {
      const i = ch.tiles[k];
      if (i < 0 || i >= this.n) continue;
      const v = trenchLevel(s, i);
      if (v === lv[i]) continue;
      lv[i] = v;
      if (v !== 0) this.any = true;
      this.markDirty(i);
    }
  }

  clearDirty(): void {
    const d = this.dirty;
    for (const b of this.dirtyList) d[b] = 0;
    this.dirtyList.length = 0;
  }

  private markDirty(i: number): void {
    const b = (((i / this.w) | 0) >> BLOCK_SHIFT) * this.bx + ((i % this.w) >> BLOCK_SHIFT);
    if (this.dirty[b]) return;
    this.dirty[b] = 1;
    this.dirtyList.push(b);
  }
}
