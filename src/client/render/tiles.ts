// Tile feed: the renderer's mirror of who owns each tile, kept up to date from the sim's change feed.
//
// Every frame the tiles changed since the last frame come from drainTileChanges(state) (no map scans). They join a
// queue that is drained over the frames until the next tick ("drip"), so a big capture grows smoothly between
// 100 ms ticks. A drained tile updates `mirror` (one uint32 per tile, uploaded as an R32UI texture):
//   bits 0-11  owner id
//   bit  12    fallout
//   bits 13-15 capture flash: 1 = taken by you, 2 = taken from you, 3 = taken between others (cleared after FLASH_MS)
//   bits 16-31 time of the capture in 0.1 s steps (mod 65536), for the flash fade in the shader
// Changed tiles mark 64 x 64 blocks dirty; the GPU (or Canvas2D) layer re-uploads only dirty blocks.
// Listeners hear every owner change with the old and the new owner (front anchors, minimap, label grid).
// When the feed overflows, a new game starts or the queue fills up, `fullGen` increments: consumers rebuild.
import { drainTileChanges } from '../../sim/changes';
import type { GameState } from '../../sim/types';
import { clamp } from './common';

export const OWNER_MASK = 0xfff;
export const FALLOUT_BIT = 1 << 12;
export const KIND_SHIFT = 13;
export const KIND_MASK = 7 << KIND_SHIFT;
export const FLASH_MINE = 1;
export const FLASH_LOST = 2;
export const FLASH_OTHER = 3;
/** How long a capture flash lasts (the shader fades it over the same time). */
export const FLASH_MS = 1600;
export const BLOCK_SHIFT = 6;
export const BLOCK = 1 << BLOCK_SHIFT;
const QUEUE_CAP = 1 << 19;
const FLASH_CAP = 1 << 17;
const DRIP_MIN_PER_FRAME = 64;
const DRIP_MAX_FRAMES = 6;

export type OwnerListener = (tile: number, oldOwner: number, newOwner: number) => void;

export class TileFeed {
  w = 0;
  h = 0;
  n = 0;
  state: GameState | null = null;
  mirror = new Uint32Array(0);
  /** increments on every full rebuild; consumers compare it with the value they last saw */
  fullGen = 0;
  bx = 0;
  by = 0;
  dirty = new Uint8Array(0);
  dirtyList: number[] = [];
  listeners: OwnerListener[] = [];
  /** tiles applied in the last update (for stats / tests) */
  applied = 0;

  private queue = new Int32Array(0);
  private qHead = 0;
  private qLen = 0;
  private queued = new Uint8Array(0);
  private flashTile = new Int32Array(FLASH_CAP);
  private flashTime = new Uint32Array(FLASH_CAP);
  private fHead = 0;
  private fLen = 0;
  private humanId = 0;
  private hasFeed = false;
  private framesLeft = 1;
  private lastLen = 0;

  reset(state: GameState): void {
    const map = state.map;
    this.state = state;
    this.w = map.width;
    this.h = map.height;
    this.n = map.width * map.height;
    this.humanId = state.humanId;
    this.mirror = new Uint32Array(this.n);
    this.queue = new Int32Array(Math.min(this.n, QUEUE_CAP));
    this.queued = new Uint8Array(this.n);
    this.bx = (this.w + BLOCK - 1) >> BLOCK_SHIFT;
    this.by = (this.h + BLOCK - 1) >> BLOCK_SHIFT;
    this.dirty = new Uint8Array(this.bx * this.by);
    this.hasFeed = !!(state as { changes?: unknown }).changes;
    if (this.hasFeed) drainTileChanges(state); // everything so far is in the full rebuild
    this.full();
  }

  /** Rebuilds the mirror from the state (flashes dropped) and marks everything dirty. */
  full(): void {
    const s = this.state;
    if (!s) return;
    const { owner, fallout } = s.map;
    const m = this.mirror;
    for (let i = 0; i < this.n; i++) m[i] = (owner[i] & OWNER_MASK) | (fallout[i] > 0 ? FALLOUT_BIT : 0);
    for (let k = 0; k < this.qLen; k++) this.queued[this.queue[(this.qHead + k) % this.queue.length]] = 0;
    this.qHead = 0;
    this.qLen = 0;
    this.lastLen = 0;
    this.fHead = 0;
    this.fLen = 0;
    this.dirty.fill(1);
    this.dirtyList.length = 0;
    for (let b = 0; b < this.dirty.length; b++) this.dirtyList.push(b);
    this.fullGen++;
  }

  /**
   * Takes this frame's share of changed tiles. `spreadFrames` = frames until the next tick (1 when paused).
   * `nowMs` is real time (the flash fades in real time).
   */
  update(nowMs: number, spreadFrames: number): void {
    const s = this.state;
    if (!s) return;
    this.applied = 0;
    if (!this.ingest(s)) {
      this.full();
      return;
    }
    const nowDs = Math.floor(nowMs / 100);
    if (this.qLen > 0) {
      // New changes restart the countdown: the queue is empty after `spreadFrames` frames.
      if (this.qLen > this.lastLen) this.framesLeft = clamp(Math.round(spreadFrames), 1, DRIP_MAX_FRAMES);
      const take = Math.min(this.qLen, Math.max(DRIP_MIN_PER_FRAME, Math.ceil(this.qLen / this.framesLeft)));
      this.framesLeft = Math.max(1, this.framesLeft - 1);
      this.apply(s, take, nowDs);
    }
    this.lastLen = this.qLen;
    this.sweepFlashes(nowDs);
  }

  /** Clears the dirty set (call after every consumer has read dirtyList). */
  clearDirty(): void {
    const d = this.dirty;
    for (const b of this.dirtyList) d[b] = 0;
    this.dirtyList.length = 0;
  }

  owner(i: number): number {
    return this.mirror[i] & OWNER_MASK;
  }

  // ------------------------------------------------------------------ internals

  /** Moves changed tiles into the queue; false = can't keep up incrementally (caller rebuilds). */
  private ingest(s: GameState): boolean {
    if (this.hasFeed) {
      const ch = drainTileChanges(s);
      if (ch.overflow) return false;
      const t = ch.tiles;
      for (let k = 0; k < ch.count; k++) if (!this.enqueue(t[k])) return false;
      return true;
    }
    // No change feed on this state: diff the whole map against the mirror (slow path, older states only).
    const { owner, fallout } = s.map;
    const m = this.mirror;
    for (let i = 0; i < this.n; i++) {
      const v = (owner[i] & OWNER_MASK) | (fallout[i] > 0 ? FALLOUT_BIT : 0);
      if (v !== (m[i] & (OWNER_MASK | FALLOUT_BIT)) && !this.enqueue(i)) return false;
    }
    return true;
  }

  private enqueue(i: number): boolean {
    if (i < 0 || i >= this.n || this.queued[i]) return true;
    const cap = this.queue.length;
    if (this.qLen >= cap) return false;
    this.queued[i] = 1;
    this.queue[(this.qHead + this.qLen) % cap] = i;
    this.qLen++;
    return true;
  }

  private apply(s: GameState, take: number, nowDs: number): void {
    const { owner, fallout } = s.map;
    const m = this.mirror;
    const q = this.queue;
    const cap = q.length;
    const me = this.humanId;
    const time = (nowDs & 0xffff) << 16;
    const ls = this.listeners;
    for (let k = 0; k < take; k++) {
      const i = q[this.qHead];
      this.qHead = (this.qHead + 1) % cap;
      this.queued[i] = 0;
      const old = m[i];
      const oldOwner = old & OWNER_MASK;
      const o = owner[i] & OWNER_MASK;
      const f = fallout[i] > 0 ? FALLOUT_BIT : 0;
      if (o === oldOwner && f === (old & FALLOUT_BIT)) continue;
      let v = o | f;
      if (o !== oldOwner) {
        // Flash: your captures (also of neutral land), your losses, and fights between others (not their expansion).
        const kind = me > 0 && o === me ? FLASH_MINE : me > 0 && oldOwner === me ? FLASH_LOST : oldOwner !== 0 && o !== 0 ? FLASH_OTHER : 0;
        if (kind) {
          v |= (kind << KIND_SHIFT) | time;
          this.pushFlash(i, nowDs);
        }
        for (let j = 0; j < ls.length; j++) ls[j](i, oldOwner, o);
      } else {
        v |= old & (KIND_MASK | 0xffff0000);
      }
      m[i] = v >>> 0;
      this.markDirty(i);
      this.applied++;
    }
    this.qLen -= take;
  }

  private pushFlash(i: number, nowDs: number): void {
    if (this.fLen >= FLASH_CAP) {
      // Ring full: drop the oldest entry (its flash just stays until the tile changes again).
      this.fHead = (this.fHead + 1) % FLASH_CAP;
      this.fLen--;
    }
    const at = (this.fHead + this.fLen) % FLASH_CAP;
    this.flashTile[at] = i;
    this.flashTime[at] = nowDs;
    this.fLen++;
  }

  private sweepFlashes(nowDs: number): void {
    const limit = nowDs - Math.ceil(FLASH_MS / 100);
    const m = this.mirror;
    while (this.fLen > 0 && this.flashTime[this.fHead] <= limit) {
      const i = this.flashTile[this.fHead];
      const t = this.flashTime[this.fHead] & 0xffff;
      this.fHead = (this.fHead + 1) % FLASH_CAP;
      this.fLen--;
      const v = m[i];
      if ((v & KIND_MASK) !== 0 && v >>> 16 === t) {
        m[i] = v & (OWNER_MASK | FALLOUT_BIT);
        this.markDirty(i);
      }
    }
  }

  private markDirty(i: number): void {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    const b = (y >> BLOCK_SHIFT) * this.bx + (x >> BLOCK_SHIFT);
    if (this.dirty[b]) return;
    this.dirty[b] = 1;
    this.dirtyList.push(b);
  }
}

/**
 * Groups dirty blocks into upload rectangles: per block row, runs of dirty blocks (gaps of up to `gap` clean blocks
 * are bridged, fewer and larger uploads). Returns tile rectangles [x, y, w, h] clipped to the map.
 */
export function dirtyRects(feed: TileFeed, gap = 1): number[][] {
  const out: number[][] = [];
  if (feed.dirtyList.length === 0) return out;
  const { bx, by, dirty, w, h } = feed;
  if (feed.dirtyList.length >= bx * by * 0.6) return [[0, 0, w, h]];
  const rows = new Set<number>();
  for (const b of feed.dirtyList) rows.add((b / bx) | 0);
  const sorted = [...rows].sort((a, b) => a - b);
  for (const r of sorted) {
    if (r >= by) continue;
    let c = 0;
    while (c < bx) {
      if (!dirty[r * bx + c]) {
        c++;
        continue;
      }
      let end = c;
      let k = c + 1;
      while (k < bx) {
        if (dirty[r * bx + k]) {
          end = k;
          k++;
        } else if (k - end <= gap) k++;
        else break;
      }
      const x0 = c << BLOCK_SHIFT;
      const y0 = r << BLOCK_SHIFT;
      const x1 = Math.min(w, (end + 1) << BLOCK_SHIFT);
      const y1 = Math.min(h, (r + 1) << BLOCK_SHIFT);
      out.push([x0, y0, x1 - x0, y1 - y0]);
      c = end + 1;
    }
  }
  return out;
}
