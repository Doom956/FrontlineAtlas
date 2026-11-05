// Fog of war (game rule Modifiers.fogOfWar): what each player sees.
//
// Vision lives on a coarse grid of territory.BLOCK x BLOCK tiles (16 x 16). Per player two bitsets: `now` = blocks in
// view at the last refresh, `seen` = blocks ever in view (explored). Sources (config FOG): own land sees FOG.landBand
// tiles past its edge, units see FOG.unit[type], finished watchtowers and ports see their radius, recon reveals see
// their circle. Allies and teammates share live vision: a player's `now` is stamped from its own sources and those of
// everyone allied with it, so what an ally showed stays explored after the alliance ends.
//
// It is part of the lockstep state (GameState.fog, hashed by hashFog) because AI nations and auto units obey it (they
// only aim at known tiles: ai.ts, airwings.ts, airstrike.ts, ...). It is created by makeGameState when the rule is on
// and changed only by updateFog inside tick(): every reader below is a pure read (no cache), so HUD reads between ticks
// can't change what the sim decides. Fog is active only while playing (not in the spawn phase, not after the end, not
// in a continued game). Spectators (viewer 0) and owners with the owner console's revealIntel flag see everything.
//
// Integer math only (squared distances), players in id order, units in array order.
import { airfieldRadius, buildingsOf, samRadius, watchtowerRadiusOf } from './buildings';
import { ARSENAL, FOG } from './config';
import { areAllied } from './diplomacy';
import { earlyWarningMul } from './specials';
import { BLOCK, blockCountsOf, borderTiles } from './territory';
import { unitVisibleTo } from './techtree';
import { isTribe } from './types';
import type { FogState, GameState, Unit } from './types';

/** Integer block offsets [dx, dy, ...] of the blocks within `r` tiles of any tile of a block (block to block gap). */
function blockDisc(r: number): Int32Array {
  const out: number[] = [];
  const k = Math.ceil(r / BLOCK) + 1;
  for (let dy = -k; dy <= k; dy++) {
    for (let dx = -k; dx <= k; dx++) {
      const gx = Math.max(0, Math.abs(dx) - 1) * BLOCK;
      const gy = Math.max(0, Math.abs(dy) - 1) * BLOCK;
      if (gx * gx + gy * gy <= r * r) out.push(dx, dy);
    }
  }
  return Int32Array.from(out);
}
/** The land band disc (a constant table built once from config, not a cache). */
const LAND_DISC = blockDisc(FOG.landBand);

/** Creates the fog state of a new game (makeGameState, only when the rule is on). Tribes and id 0 get no vision. */
export function createFog(state: GameState): FogState {
  const bw = Math.ceil(state.map.width / BLOCK);
  const bh = Math.ceil(state.map.height / BLOCK);
  const words = (bw * bh + 31) >>> 5;
  const seen: (Uint32Array | null)[] = [];
  const now: (Uint32Array | null)[] = [];
  for (const p of state.players) {
    const has = p.id > 0 && !isTribe(p);
    seen.push(has ? new Uint32Array(words) : null);
    now.push(has ? new Uint32Array(words) : null);
  }
  return { bw, bh, words, seen, now };
}

/** True while the fog rule shapes what players see and what AI / auto units may aim at. */
export function fogOn(state: GameState): boolean {
  return !!state.fog && state.phase === 'playing' && !state.continued;
}

/** True when `viewer` sees everything (no fog for it): fog off, a spectator, a tribe, or the owner's revealIntel. */
export function seesAll(state: GameState, viewer: number): boolean {
  if (!fogOn(state) || viewer <= 0) return true;
  if (state.admin && state.admin.revealIntel.includes(viewer)) return true;
  return !state.fog!.now[viewer];
}

/** Block index of a tile. */
export function blockOf(state: GameState, tile: number): number {
  const w = state.map.width;
  const x = tile % w;
  const y = (tile - x) / w;
  return ((y / BLOCK) | 0) * state.fog!.bw + ((x / BLOCK) | 0);
}
function bit(words: Uint32Array, b: number): boolean {
  return (words[b >>> 5] & (1 << (b & 31))) !== 0;
}

/** True when `viewer` sees `tile` now (in view). Pure read. */
export function visibleTile(state: GameState, viewer: number, tile: number): boolean {
  if (seesAll(state, viewer)) return true;
  if (tile < 0 || tile >= state.map.owner.length) return false;
  return bit(state.fog!.now[viewer]!, blockOf(state, tile));
}
/** True when `viewer` has ever seen `tile` (explored). Pure read. */
export function knownTile(state: GameState, viewer: number, tile: number): boolean {
  if (seesAll(state, viewer)) return true;
  if (tile < 0 || tile >= state.map.owner.length) return false;
  return bit(state.fog!.seen[viewer]!, blockOf(state, tile));
}

/** Tile under a unit (rounded position, clamped to the map). */
function unitTile(state: GameState, u: Unit): number {
  const w = state.map.width;
  const x = Math.max(0, Math.min(w - 1, Math.round(u.x)));
  const y = Math.max(0, Math.min(state.map.height - 1, Math.round(u.y)));
  return y * w + x;
}

/** Aircraft and missiles: in a visible block, or inside the (Early Warning widened) radar of a SAM or airfield of the viewer or an ally. */
export function airSeen(state: GameState, viewer: number, u: Unit): boolean {
  if (visibleTile(state, viewer, unitTile(state, u))) return true;
  for (const p of state.players) {
    if (p.id <= 0 || !p.alive || (p.id !== viewer && !areAllied(state, viewer, p.id))) continue;
    for (const b of buildingsOf(state, p.id, 'sam')) if (b.buildLeft <= 0 && inRadius(state, b.tile, u, samRadius(b) * earlyWarningMul(state, p.id))) return true;
    for (const b of buildingsOf(state, p.id, 'airfield')) if (b.buildLeft <= 0 && inRadius(state, b.tile, u, airfieldRadius(b) * earlyWarningMul(state, p.id))) return true;
  }
  return false;
}
function inRadius(state: GameState, tile: number, u: Unit, r: number): boolean {
  const w = state.map.width;
  const dx = (tile % w) - u.x;
  const dy = ((tile / w) | 0) - u.y;
  return dx * dx + dy * dy <= r * r;
}
const AIR = new Set(['bomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb']);

/** True when `viewer` may see unit u: own and allied always; aircraft and missiles by airSeen; others in view. Submarines must also pass techtree.unitVisibleTo. Pure read. */
export function unitSeen(state: GameState, viewer: number, u: Unit): boolean {
  if (!unitVisibleTo(state, viewer, u)) return false;
  if (seesAll(state, viewer) || u.owner === viewer || areAllied(state, viewer, u.owner)) return true;
  return AIR.has(u.type) ? airSeen(state, viewer, u) : visibleTile(state, viewer, unitTile(state, u));
}

/**
 * A recon aim past a front tile when the target's capital is unknown (fog of war): one recon radius beyond `front`,
 * on the line from `owner`'s capital (or nothing) through it. -1 when that falls off the map or no line exists.
 */
export function pushInward(state: GameState, owner: number, _nation: number, front: number): number {
  const map = state.map;
  const w = map.width;
  const cap = state.players[owner]?.capital ?? -1;
  if (front < 0 || cap < 0) return -1;
  const dx = (front % w) - (cap % w);
  const dy = ((front / w) | 0) - ((cap / w) | 0);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return -1;
  const x = Math.round((front % w) + (dx / len) * ARSENAL.reconRadius);
  const y = Math.round(((front / w) | 0) + (dy / len) * ARSENAL.reconRadius);
  if (x < 0 || y < 0 || x >= w || y >= map.height) return -1;
  return y * w + x;
}

/** AI recon in fog when it knows neither the foe's capital nor a building: past a known edge of the foe's land; -1 = none. */
export function fogReconAim(state: GameState, id: number, foe: number): number {
  const b = borderTiles(state, foe);
  if (!b.len) return -1;
  const step = Math.max(1, Math.floor(b.len / 16));
  for (let k = 0; k < b.len; k += step) {
    const t = b.list[k];
    if (knownTile(state, id, t)) return pushInward(state, id, foe, t);
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// Refresh (inside tick only)
// ---------------------------------------------------------------------------------------------------------------

/** Marks every block whose nearest point is within r of tile point (cx, cy). */
function stampPoint(words: Uint32Array, bw: number, bh: number, cx: number, cy: number, r: number): void {
  if (r <= 0) return;
  const bx0 = Math.max(0, Math.floor((cx - r) / BLOCK));
  const bx1 = Math.min(bw - 1, Math.floor((cx + r) / BLOCK));
  const by0 = Math.max(0, Math.floor((cy - r) / BLOCK));
  const by1 = Math.min(bh - 1, Math.floor((cy + r) / BLOCK));
  const r2 = r * r;
  for (let by = by0; by <= by1; by++) {
    const y0 = by * BLOCK;
    const dy = cy < y0 ? y0 - cy : cy > y0 + BLOCK - 1 ? cy - (y0 + BLOCK - 1) : 0;
    for (let bx = bx0; bx <= bx1; bx++) {
      const x0 = bx * BLOCK;
      const dx = cx < x0 ? x0 - cx : cx > x0 + BLOCK - 1 ? cx - (x0 + BLOCK - 1) : 0;
      if (dx * dx + dy * dy <= r2) {
        const b = by * bw + bx;
        words[b >>> 5] |= 1 << (b & 31);
      }
    }
  }
}

/** Stamps everything source player q sees into words. */
function stampSource(state: GameState, words: Uint32Array, q: number): void {
  const f = state.fog!;
  const { bw, bh } = f;
  const w = state.map.width;
  // Land: every block holding a tile of q stamps the land band disc.
  const { counts } = blockCountsOf(state, q);
  const nb = bw * bh;
  // A block whose 8 neighbours are all q's (or off the map) only marks itself: its disc is covered by the discs of
  // the blocks between it and any land that is not q's (the disc shrinks monotonically toward its centre).
  const own = (x: number, y: number): boolean => x < 0 || y < 0 || x >= bw || y >= bh || counts[y * bw + x] > 0;
  for (let b = 0; b < nb && b < counts.length; b++) {
    if (counts[b] === 0) continue;
    const bx = b % bw;
    const by = (b - bx) / bw;
    if (own(bx - 1, by - 1) && own(bx, by - 1) && own(bx + 1, by - 1) && own(bx - 1, by) && own(bx + 1, by) && own(bx - 1, by + 1) && own(bx, by + 1) && own(bx + 1, by + 1)) {
      words[b >>> 5] |= 1 << (b & 31);
      continue;
    }
    for (let k = 0; k < LAND_DISC.length; k += 2) {
      const x = bx + LAND_DISC[k];
      const y = by + LAND_DISC[k + 1];
      if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
      const c = y * bw + x;
      words[c >>> 5] |= 1 << (c & 31);
    }
  }
  // Units.
  for (const u of state.units) {
    if (u.owner !== q || u.hp <= 0) continue;
    const r = u.type === 'warship' && u.variant === 'submarine' ? FOG.unit.submarine : FOG.unit[u.type] ?? 0;
    if (r > 0) stampPoint(words, bw, bh, Math.round(u.x), Math.round(u.y), r);
  }
  // Finished watchtowers and ports.
  for (const b of buildingsOf(state, q, 'watchtower')) {
    if (b.buildLeft > 0 || state.map.owner[b.tile] !== q) continue;
    stampPoint(words, bw, bh, b.tile % w, (b.tile / w) | 0, Math.floor(watchtowerRadiusOf(state, b) * FOG.watchtowerMul));
  }
  for (const b of buildingsOf(state, q, 'port')) {
    if (b.buildLeft > 0 || state.map.owner[b.tile] !== q) continue;
    stampPoint(words, bw, bh, b.tile % w, (b.tile / w) | 0, FOG.portSea);
  }
  // Recon reveals (variants.ts).
  for (const z of state.arsenal?.reveals ?? []) {
    if (z.owner !== q || z.untilTick <= state.tick) continue;
    stampPoint(words, bw, bh, z.tile % w, (z.tile / w) | 0, Math.ceil(z.radius));
  }
}

/** Recomputes player p's vision now (own sources plus every ally's and teammate's) and adds it to what it has seen. */
function refresh(state: GameState, p: number): void {
  const f = state.fog!;
  const now = f.now[p];
  const seen = f.seen[p];
  if (!now || !seen) return;
  now.fill(0);
  if (!state.players[p].alive) return;
  stampSource(state, now, p);
  for (const q of state.players) {
    if (q.id <= 0 || q.id === p || !q.alive || !areAllied(state, p, q.id)) continue;
    stampSource(state, now, q.id);
  }
  for (let k = 0; k < now.length; k++) seen[k] |= now[k];
}

/**
 * Vision refresh (sim.ts, after updateArsenal): humans every FOG.humanTicks, AI nations every FOG.aiTicks, staggered
 * by id. `all` refreshes every player (the moment play starts). No-op without fog or outside the playing phase.
 */
export function updateFog(state: GameState, all = false): void {
  if (!fogOn(state)) return;
  const f = state.fog!;
  for (const p of state.players) {
    if (!f.now[p.id]) continue;
    const every = p.isHuman ? FOG.humanTicks : FOG.aiTicks;
    if (all || (state.tick + p.id) % every === 0) refresh(state, p.id);
  }
}

/** Mixes the fog state into the state hash (hash.ts). Absent fog mixes nothing, so games without it hash as before. */
export function hashFog(state: GameState, h: number, mixInt: (h: number, v: number) => number): number {
  const f = state.fog;
  if (!f) return h;
  h = mixInt(h, f.bw);
  h = mixInt(h, f.bh);
  for (let id = 0; id < f.now.length; id++) {
    const now = f.now[id];
    const seen = f.seen[id];
    h = mixInt(h, now ? 1 : 0);
    if (!now || !seen) continue;
    for (let k = 0; k < seen.length; k++) h = mixInt(h, seen[k]);
    for (let k = 0; k < now.length; k++) h = mixInt(h, now[k]);
  }
  return h;
}
