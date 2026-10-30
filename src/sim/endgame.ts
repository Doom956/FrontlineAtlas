// Endgame cleanup: pockets (enclaves) fully surrounded by one hostile nation are annexed by it, and a small nation
// whose whole territory is surrounded by one hostile nation is absorbed. (Small nations that get hit collapse in
// combat.ts; this catches the ones nobody is attacking any more.)
//
// Per player, staggered: each player is checked every ENCLAVE_CHECK_SECONDS at its own tick (hash of its id), and
// only if tiles changed on or next to its land since the last check (territory.takeRecentChanges). Pockets form right
// where land changed hands, so a check floods the player's pieces of land next to those tiles only; a piece stops
// being flooded as soon as it is known to be open (it touches water, neutral land or two different owners) or bigger
// than POCKET_MAX_TILES (a big piece is a front, not a pocket), so the cost stays small on huge maps. A player below
// its collapse threshold is checked whole (its main body too).
import { annexTiles, collapseThreshold } from './combat';
import { ENCLAVE_CHECK_SECONDS, TICKS_PER_SECOND } from './config';
import { areAllied } from './diplomacy';
import { addEvent } from './state';
import { borderTiles, isDirty, takeRecentChanges } from './territory';
import type { GameState } from './types';

/** Pockets smaller than this are annexed without an event (specks a front left behind). */
const POCKET_EVENT_TILES = 12;
/** Pieces bigger than this are never pockets (they stay; the attack on them goes on). */
export const POCKET_MAX_TILES = 4000;

interface Scratch {
  /** (generation << 16 | piece index) per visited tile */
  stamp: Uint32Array;
  gen: number;
  queue: Int32Array;
}
// Scratch buffers per game (never shared between two games).
const scratch = new WeakMap<GameState, Scratch>();

function buffers(state: GameState): Scratch {
  const n = state.map.width * state.map.height;
  let s = scratch.get(state);
  if (!s || s.stamp.length !== n) {
    s = { stamp: new Uint32Array(n), gen: 0, queue: new Int32Array(1024) };
    scratch.set(state, s);
  }
  s.gen++;
  if (s.gen >= 0xffff) {
    s.stamp.fill(0);
    s.gen = 1;
  }
  return s;
}

interface Piece {
  start: number;
  end: number;
  /** the single foreign owner around it, -1 if open (neutral land, water, two or more owners) */
  surrounder: number;
}

/**
 * Checks one player's pieces of land and annexes the closed ones: a piece surrounded entirely by one hostile (not
 * allied) nation goes to it when it is less than half of the player's land, or when the player is below its
 * collapse threshold (then even its main body). Water or neutral land next to a piece means it is open; the map
 * edge doesn't count. `near` = tiles where land changed hands: only the pieces next to them are checked (all border
 * tiles when omitted or when the player is small). Returns the tiles moved.
 */
export function checkEnclaves(state: GameState, playerId: number, near?: number[]): number {
  const p = state.players[playerId];
  if (!p || playerId <= 0 || !p.alive || p.tiles <= 0) return 0;
  const map = state.map;
  const { width: w, owner, terrain } = map;
  const n = owner.length;
  const sc = buffers(state);
  const stamp = sc.stamp;
  const gen = sc.gen;
  const tag = gen << 16;
  const threshold = collapseThreshold(p);
  const small = p.tiles < threshold;
  const cap = small ? p.tiles + 1 : Math.min(POCKET_MAX_TILES, Math.ceil(p.tiles / 2));
  let starts: number[];
  if (near && !small) {
    starts = [];
    for (const t of near) {
      if (owner[t] === playerId) starts.push(t);
      const x = t % w;
      if (x > 0 && owner[t - 1] === playerId) starts.push(t - 1);
      if (x < w - 1 && owner[t + 1] === playerId) starts.push(t + 1);
      if (t >= w && owner[t - w] === playerId) starts.push(t - w);
      if (t < n - w && owner[t + w] === playerId) starts.push(t + w);
    }
  } else {
    const { list, len } = borderTiles(state, playerId);
    starts = Array.from(list.subarray(0, len));
  }
  const pieces: Piece[] = [];
  let tail = 0;
  for (const s0 of starts) {
    if (owner[s0] !== playerId || stamp[s0] >>> 16 === gen) continue;
    if (pieces.length >= 0xffff) break;
    const id = pieces.length;
    const start = tail;
    let head = tail;
    if (tail >= sc.queue.length) grow(sc, n);
    stamp[s0] = tag | id;
    sc.queue[tail++] = s0;
    let sur = 0; // 0 = none seen yet, -1 = open
    while (head < tail && sur !== -1) {
      if (tail - start > cap) {
        sur = -1; // too big to be a pocket
        break;
      }
      const t = sc.queue[head++];
      const x = t % w;
      for (let k = 0; k < 4; k++) {
        let j: number;
        if (k === 0) {
          if (x === 0) continue;
          j = t - 1;
        } else if (k === 1) {
          if (x === w - 1) continue;
          j = t + 1;
        } else if (k === 2) {
          if (t < w) continue;
          j = t - w;
        } else {
          if (t >= n - w) continue;
          j = t + w;
        }
        const oj = owner[j];
        if (oj === playerId) {
          const st = stamp[j];
          if (st >>> 16 !== gen) {
            stamp[j] = tag | id;
            if (tail >= sc.queue.length) grow(sc, n);
            sc.queue[tail++] = j;
          } else if ((st & 0xffff) !== id) {
            sur = -1; // joins a piece already known to be open
          }
          continue;
        }
        if (sur === -1) continue;
        if (oj === 0 || terrain[j] <= 1) sur = -1;
        else if (sur === 0) sur = oj;
        else if (sur !== oj) sur = -1;
      }
    }
    pieces.push({ start, end: tail, surrounder: sur > 0 ? sur : -1 });
  }

  let annexed = 0;
  const tilesBefore = p.tiles;
  for (const piece of pieces) {
    const by = piece.surrounder;
    if (by <= 0) continue;
    const taker = state.players[by];
    if (!taker || !taker.alive || !p.alive || areAllied(state, playerId, by)) continue;
    const size = piece.end - piece.start;
    const isMain = size * 2 >= tilesBefore;
    if (isMain && tilesBefore >= threshold) continue;
    const tiles = Array.from(sc.queue.subarray(piece.start, piece.end));
    const name = p.name;
    const moved = annexTiles(state, playerId, by, tiles);
    if (moved <= 0) continue;
    annexed += moved;
    // Specks left behind by a front are cleaned up quietly; real pockets get an event.
    if (!isMain && moved < POCKET_EVENT_TILES) continue;
    const msg = isMain ? `${taker.name} absorbed ${name}, which it had surrounded` : `${taker.name} annexed an encircled pocket of ${name} (${moved} tiles)`;
    addEvent(state, 'info', msg, [playerId, by], tiles[0]);
  }
  return annexed;
}

function grow(sc: Scratch, n: number): void {
  const q = new Int32Array(Math.min(n, sc.queue.length * 2));
  q.set(sc.queue);
  sc.queue = q;
}

/** Checks every player now, from all their border tiles (tests, scripts). Returns the tiles moved. */
export function annexEnclaves(state: GameState): number {
  let moved = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || !p.spawned) continue;
    takeRecentChanges(state, p.id);
    moved += checkEnclaves(state, p.id);
  }
  return moved;
}

/** Deterministic spread of the per-player checks over the interval. */
function stagger(id: number, every: number): number {
  let a = Math.imul(id ^ 0x5bd1e995, 0x9e3779b1);
  a ^= a >>> 15;
  return (a >>> 0) % every;
}

/** Endgame cleanup tick: each player with a changed border is checked every ENCLAVE_CHECK_SECONDS, staggered. */
export function updateEndgame(state: GameState): void {
  if (state.phase !== 'playing') return;
  const every = Math.max(1, Math.round(ENCLAVE_CHECK_SECONDS * TICKS_PER_SECOND));
  const slot = state.tick % every;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || !p.spawned) continue;
    if (stagger(p.id, every) !== slot || !isDirty(state, p.id)) continue;
    checkEnclaves(state, p.id, takeRecentChanges(state, p.id));
  }
}
