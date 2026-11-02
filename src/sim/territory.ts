// Per-player territory data kept up to date incrementally by setOwner (no full-map scans at play time).
//
// - border sets: every owned tile with a 4-neighbour of land owned by someone else (or neutral land), per player, as
//   a dense list plus a position index per tile (O(1) add / remove). Fronts, neighbours, border lengths and enclave
//   checks start from them.
// - land weight: sum over owned land of terrain pop/tile / 30 (fallout tiles count 0), for the troop cap and gold.
// - counts of owned coastal tiles and iron / oil deposits, plus lazy lists of them for sampling (entries that left
//   are dropped when the list is read).
// - block counts: tiles per player per BLOCK x BLOCK block (watchtower intel: "does q own land near here").
// - recent changes: per player, the last RECENT tiles that changed owner on or next to its land since its last enclave
//   check (pockets form right there).
// - static land components of the map (which landmass a tile is on), for "can I reach this by land".
//
// All of it lives in a WeakMap keyed by the GameState (one per game, never shared), built from the map on first use
// and then maintained by onOwnerChange / onFalloutChange, which setOwner and the fallout code call.
import { TERRAIN } from './config';
import type { GameState, MapData, TerrainId } from './types';

/** Block size of the per-player tile counts (watchtower intel). */
export const BLOCK = 16;

interface Territory {
  n: number;
  pc: number;
  w: number;
  h: number;
  /** position of the tile in its owner's border list, -1 if not a border tile */
  borderPos: Int32Array;
  borderList: Int32Array[];
  borderLen: Int32Array;
  /** land weight (pop/tile / 30) per player, fallout included; falloutWeight is the part under fallout */
  weight: Float64Array;
  falloutWeight: Float64Array;
  coastCount: Int32Array;
  ironCount: Int32Array;
  oilCount: Int32Array;
  coastList: number[][];
  ironList: number[][];
  oilList: number[][];
  bw: number;
  bh: number;
  blocks: Uint16Array;
  /** ring buffer of recent change tiles per player (RECENT each) and how many were written since the last check */
  recent: Int32Array;
  recentCount: Int32Array;
}

/** Recent change tiles kept per player for the enclave check. */
const RECENT = 48;

const territories = new WeakMap<GameState, Territory>();
// Terrain weight per terrain id (pop/tile / 30): a constant table, not a cache.
const WEIGHT = new Float64Array(9);
for (let t = 2; t < 9; t++) WEIGHT[t] = TERRAIN[t as TerrainId].popPerTile / 30;

function isBorderTile(owner: Uint16Array, terrain: Uint8Array, w: number, n: number, i: number, o: number): boolean {
  const x = i % w;
  if (x > 0 && owner[i - 1] !== o && terrain[i - 1] > 1) return true;
  if (x < w - 1 && owner[i + 1] !== o && terrain[i + 1] > 1) return true;
  if (i >= w && owner[i - w] !== o && terrain[i - w] > 1) return true;
  if (i < n - w && owner[i + w] !== o && terrain[i + w] > 1) return true;
  return false;
}

function addBorder(t: Territory, i: number, o: number): void {
  if (t.borderPos[i] >= 0) return;
  let list = t.borderList[o];
  const len = t.borderLen[o];
  if (len >= list.length) {
    const grown = new Int32Array(Math.max(64, list.length * 2));
    grown.set(list);
    t.borderList[o] = list = grown;
  }
  list[len] = i;
  t.borderPos[i] = len;
  t.borderLen[o] = len + 1;
}
function removeBorder(t: Territory, i: number, o: number): void {
  const pos = t.borderPos[i];
  if (pos < 0) return;
  const list = t.borderList[o];
  const last = t.borderLen[o] - 1;
  const moved = list[last];
  list[pos] = moved;
  t.borderPos[moved] = pos;
  t.borderPos[i] = -1;
  t.borderLen[o] = last;
}
function refreshBorder(t: Territory, map: MapData, i: number): void {
  const o = map.owner[i];
  if (o === 0 || o >= t.pc) return;
  if (isBorderTile(map.owner, map.terrain, t.w, t.n, i, o)) addBorder(t, i, o);
  else removeBorder(t, i, o);
}

function build(state: GameState): Territory {
  const map = state.map;
  const { width: w, height: h, owner, terrain, coastal, resource, fallout } = map;
  const n = w * h;
  const pc = state.players.length;
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const t: Territory = {
    n,
    pc,
    w,
    h,
    borderPos: new Int32Array(n).fill(-1),
    borderList: Array.from({ length: pc }, () => new Int32Array(0)),
    borderLen: new Int32Array(pc),
    weight: new Float64Array(pc),
    falloutWeight: new Float64Array(pc),
    coastCount: new Int32Array(pc),
    ironCount: new Int32Array(pc),
    oilCount: new Int32Array(pc),
    coastList: Array.from({ length: pc }, () => []),
    ironList: Array.from({ length: pc }, () => []),
    oilList: Array.from({ length: pc }, () => []),
    bw,
    bh,
    blocks: new Uint16Array(pc * bw * bh),
    recent: new Int32Array(pc * RECENT),
    recentCount: new Int32Array(pc),
  };
  const nb = bw * bh;
  for (let i = 0; i < n; i++) {
    const o = owner[i];
    if (o === 0 || o >= pc) continue;
    const ter = terrain[i];
    if (ter > 1) {
      t.weight[o] += WEIGHT[ter];
      if (fallout[i] > 0) t.falloutWeight[o] += WEIGHT[ter];
    }
    if (coastal[i]) {
      t.coastCount[o]++;
      t.coastList[o].push(i);
    }
    const r = resource[i];
    if (r === 1) {
      t.ironCount[o]++;
      t.ironList[o].push(i);
    } else if (r === 2) {
      t.oilCount[o]++;
      t.oilList[o].push(i);
    }
    const x = i % w;
    const y = (i - x) / w;
    t.blocks[o * nb + ((y / BLOCK) | 0) * bw + ((x / BLOCK) | 0)]++;
    if (isBorderTile(owner, terrain, w, n, i, o)) {
      addBorder(t, i, o);
      noteChange(t, o, i);
    }
  }
  territories.set(state, t);
  return t;
}

/** The territory data of a game (built from the map on first use). */
function get(state: GameState): Territory {
  const t = territories.get(state);
  if (t && t.n === state.map.owner.length && t.pc === state.players.length) return t;
  return build(state);
}

/** Builds the territory data now (call once when a game is created, so play never pays for the first scan). */
export function initTerritory(state: GameState): void {
  build(state);
}

/**
 * setOwner hook, called right after map.owner[tile] changed from `old` to `nw`. Keeps border sets, land weights,
 * coast / deposit counts, block counts and dirty flags in sync. No-op until the data was built (it is then built from
 * the map, which already holds the change).
 */
export function onOwnerChange(state: GameState, tile: number, old: number, nw: number): void {
  const t = territories.get(state);
  if (!t || t.n !== state.map.owner.length || t.pc !== state.players.length) return;
  const map = state.map;
  const { terrain, coastal, resource, fallout } = map;
  const w = t.w;
  const ter = terrain[tile];
  const wt = ter > 1 ? WEIGHT[ter] : 0;
  const fo = fallout[tile] > 0;
  const nb = t.bw * t.bh;
  const x = tile % w;
  const block = (((tile - x) / w / BLOCK) | 0) * t.bw + ((x / BLOCK) | 0);
  const r = resource[tile];
  if (old > 0 && old < t.pc) {
    t.weight[old] -= wt;
    if (fo) t.falloutWeight[old] -= wt;
    if (coastal[tile]) t.coastCount[old]--;
    if (r === 1) t.ironCount[old]--;
    else if (r === 2) t.oilCount[old]--;
    t.blocks[old * nb + block]--;
    removeBorder(t, tile, old);
    noteChange(t, old, tile);
  }
  if (nw > 0 && nw < t.pc) {
    t.weight[nw] += wt;
    if (fo) t.falloutWeight[nw] += wt;
    if (coastal[tile]) {
      t.coastCount[nw]++;
      addOwned(state, t.coastList[nw], t.coastCount[nw], tile, nw);
    }
    if (r === 1) {
      t.ironCount[nw]++;
      addOwned(state, t.ironList[nw], t.ironCount[nw], tile, nw);
    } else if (r === 2) {
      t.oilCount[nw]++;
      addOwned(state, t.oilList[nw], t.oilCount[nw], tile, nw);
    }
    t.blocks[nw * nb + block]++;
    refreshBorder(t, map, tile);
  }
  const owner = map.owner;
  const n = t.n;
  // Neighbours: their border status may change, and a third owner next to the tile may have been closed in.
  let last = nw;
  if (x > 0) {
    refreshBorder(t, map, tile - 1);
    const o = owner[tile - 1];
    if (o !== nw && o !== old && o !== last) noteChange(t, (last = o), tile);
  }
  if (x < w - 1) {
    refreshBorder(t, map, tile + 1);
    const o = owner[tile + 1];
    if (o !== nw && o !== old && o !== last) noteChange(t, (last = o), tile);
  }
  if (tile >= w) {
    refreshBorder(t, map, tile - w);
    const o = owner[tile - w];
    if (o !== nw && o !== old && o !== last) noteChange(t, (last = o), tile);
  }
  if (tile < n - w) {
    refreshBorder(t, map, tile + w);
    const o = owner[tile + w];
    if (o !== nw && o !== old && o !== last) noteChange(t, (last = o), tile);
  }
}

function noteChange(t: Territory, o: number, tile: number): void {
  if (o <= 0 || o >= t.pc) return;
  const c = t.recentCount[o];
  t.recent[o * RECENT + (c % RECENT)] = tile;
  t.recentCount[o] = c + 1;
}

/** Fallout hook: call after map.fallout[tile] went from 0 to > 0 (on = true) or back to 0 (on = false). */
export function onFalloutChange(state: GameState, tile: number, on: boolean): void {
  const t = territories.get(state);
  if (!t) return;
  const o = state.map.owner[tile];
  const ter = state.map.terrain[tile];
  if (o === 0 || o >= t.pc || ter <= 1) return;
  t.falloutWeight[o] += on ? WEIGHT[ter] : -WEIGHT[ter];
}

/** Border tiles of a player: the first `len` entries of `list` (do not modify; valid until the next setOwner). */
export function borderTiles(state: GameState, playerId: number): { list: Int32Array; len: number } {
  const t = get(state);
  if (playerId <= 0 || playerId >= t.pc) return { list: new Int32Array(0), len: 0 };
  return { list: t.borderList[playerId], len: t.borderLen[playerId] };
}

/** Land weight of a player: sum over owned land of pop/tile / 30 (plains 1, mountains 0.17), fallout tiles 0. */
export function landWeight(state: GameState, playerId: number): number {
  const t = get(state);
  if (playerId <= 0 || playerId >= t.pc) return 0;
  return Math.max(0, t.weight[playerId] - t.falloutWeight[playerId]);
}

export function coastCount(state: GameState, playerId: number): number {
  const t = get(state);
  return playerId > 0 && playerId < t.pc ? t.coastCount[playerId] : 0;
}
/** Owned iron (kind 1) or oil (kind 2) deposit tiles. */
export function depositCount(state: GameState, playerId: number, kind: 1 | 2): number {
  const t = get(state);
  if (playerId <= 0 || playerId >= t.pc) return 0;
  return kind === 1 ? t.ironCount[playerId] : t.oilCount[playerId];
}

/** Compacts a lazy list: keeps tiles still owned by playerId, once each. */
/**
 * Appends a tile the player just took to one of its lazy owned-tile lists, compacting the list once it holds twice
 * the real count. Only here (in setOwner), never in a read: ownedTilesOf is also called by the client between ticks
 * (advisor), and a compaction at a client-chosen moment would change what the AI samples from the list (lockstep).
 */
function addOwned(state: GameState, list: number[], count: number, tile: number, playerId: number): void {
  list.push(tile);
  if (list.length > count * 2 + 64) compact(state, list, playerId);
}
function compact(state: GameState, list: number[], playerId: number): void {
  const owner = state.map.owner;
  const seen = new Set<number>();
  let k = 0;
  for (const i of list) {
    if (owner[i] !== playerId || seen.has(i)) continue;
    seen.add(i);
    list[k++] = i;
  }
  list.length = k;
}

/**
 * Owned coastal tiles ('coast'), iron deposits ('iron') or oil deposits ('oil') of a player. The list is kept lazily:
 * it may still hold tiles the player lost or the same tile twice (it is compacted when a tile is added and it
 * holds twice the real count), so check the owner of every entry. Do not modify it.
 */
export function ownedTilesOf(state: GameState, playerId: number, kind: 'coast' | 'iron' | 'oil'): readonly number[] {
  const t = get(state);
  if (playerId <= 0 || playerId >= t.pc) return [];
  const lists = kind === 'coast' ? t.coastList : kind === 'iron' ? t.ironList : t.oilList;
  return lists[playerId]; // compacted only when a tile is added (addOwned): a read never changes it
}

/**
 * Up to k random distinct tiles from ownedTilesOf that the player still owns (random indexes with state.rng, no
 * copy of the list).
 */
export function sampleOwnedTiles(state: GameState, playerId: number, kind: 'coast' | 'iron' | 'oil', k: number): number[] {
  const list = ownedTilesOf(state, playerId, kind);
  const owner = state.map.owner;
  const out: number[] = [];
  if (!list.length || k <= 0) return out;
  if (list.length <= k * 2) {
    for (const i of list) if (owner[i] === playerId && !out.includes(i)) out.push(i);
    return out.length > k ? out.slice(0, k) : out;
  }
  for (let tries = 0; tries < k * 4 && out.length < k; tries++) {
    const i = list[Math.floor(state.rng() * list.length)];
    if (owner[i] === playerId && !out.includes(i)) out.push(i);
  }
  return out;
}

/** True if playerId owns a tile in some BLOCK x BLOCK block whose nearest point is within r of tile. */
export function ownsNear(state: GameState, playerId: number, tile: number, r: number): boolean {
  const t = get(state);
  if (playerId <= 0 || playerId >= t.pc) return false;
  const w = t.w;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  const r2 = r * r;
  const bx0 = Math.max(0, Math.floor((cx - r) / BLOCK));
  const bx1 = Math.min(t.bw - 1, Math.floor((cx + r) / BLOCK));
  const by0 = Math.max(0, Math.floor((cy - r) / BLOCK));
  const by1 = Math.min(t.bh - 1, Math.floor((cy + r) / BLOCK));
  const base = playerId * t.bw * t.bh;
  for (let by = by0; by <= by1; by++) {
    const y0 = by * BLOCK;
    const dy = cy < y0 ? y0 - cy : cy > y0 + BLOCK - 1 ? cy - (y0 + BLOCK - 1) : 0;
    for (let bx = bx0; bx <= bx1; bx++) {
      if (t.blocks[base + by * t.bw + bx] === 0) continue;
      const x0 = bx * BLOCK;
      const dx = cx < x0 ? x0 - cx : cx > x0 + BLOCK - 1 ? cx - (x0 + BLOCK - 1) : 0;
      if (dx * dx + dy * dy <= r2) return true;
    }
  }
  return false;
}

/** Tiles playerId owns in the block containing tile (0 if none). */
export function tilesInBlock(state: GameState, playerId: number, tile: number): number {
  const t = get(state);
  if (playerId <= 0 || playerId >= t.pc) return 0;
  const x = tile % t.w;
  const y = (tile / t.w) | 0;
  return t.blocks[playerId * t.bw * t.bh + ((y / BLOCK) | 0) * t.bw + ((x / BLOCK) | 0)];
}

/** True if tiles changed owner on or next to the player's land since its recent changes were last taken. */
export function isDirty(state: GameState, playerId: number): boolean {
  const t = get(state);
  return playerId > 0 && playerId < t.pc && t.recentCount[playerId] > 0;
}
/** The (up to RECENT latest) tiles that changed owner on or next to the player's land; clears the list. */
export function takeRecentChanges(state: GameState, playerId: number): number[] {
  const t = get(state);
  if (playerId <= 0 || playerId >= t.pc) return [];
  const c = t.recentCount[playerId];
  const k = Math.min(c, RECENT);
  const out: number[] = [];
  for (let q = 0; q < k; q++) out.push(t.recent[playerId * RECENT + ((c - 1 - q) % RECENT)]);
  t.recentCount[playerId] = 0;
  return out;
}
/** Forgets the player's recent changes. */
export function clearDirty(state: GameState, playerId: number): void {
  const t = get(state);
  if (playerId > 0 && playerId < t.pc) t.recentCount[playerId] = 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Static land components (the map's terrain never changes): component id per tile, 0 for water.
// ---------------------------------------------------------------------------------------------------------------

const components = new WeakMap<MapData, Int32Array>();

/** Landmass id of every tile (4-connected land; 0 = water). Computed once per map. */
export function landComponents(map: MapData): Int32Array {
  let c = components.get(map);
  if (c && c.length === map.terrain.length) return c;
  const { width: w, terrain } = map;
  const n = terrain.length;
  c = new Int32Array(n);
  const queue = new Int32Array(n);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (terrain[s] <= 1 || c[s] !== 0) continue;
    id++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    c[s] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      if (x > 0 && terrain[i - 1] > 1 && c[i - 1] === 0) (c[i - 1] = id), (queue[tail++] = i - 1);
      if (x < w - 1 && terrain[i + 1] > 1 && c[i + 1] === 0) (c[i + 1] = id), (queue[tail++] = i + 1);
      if (i >= w && terrain[i - w] > 1 && c[i - w] === 0) (c[i - w] = id), (queue[tail++] = i - w);
      if (i < n - w && terrain[i + w] > 1 && c[i + w] === 0) (c[i + w] = id), (queue[tail++] = i + w);
    }
  }
  components.set(map, c);
  return c;
}
