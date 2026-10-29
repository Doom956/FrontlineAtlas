// Win/lose detection and scores.
import { TICKS_PER_SECOND, VICTORY_LAND_SHARE } from './config';
import { population } from './economy';
import { addEvent } from './state';
import type { GameState } from './types';

/** Finished buildings owned by playerId (one pass over all buildings). */
function finishedBuildings(state: GameState, playerId: number): number {
  let n = 0;
  for (const b of state.buildings.values()) if (b.owner === playerId && b.buildLeft <= 0) n++;
  return n;
}

/** Score = tiles + population / 100 + finished buildings x 50 (DESIGN section 9). */
export function score(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p || playerId === 0) return 0;
  return Math.floor(p.tiles + population(p) / 100 + finishedBuildings(state, playerId) * 50);
}

/** Scores of all players at once (index = player id), cheaper than calling score() per player. */
export function allScores(state: GameState): number[] {
  const counts = new Array<number>(state.players.length).fill(0);
  for (const b of state.buildings.values()) if (b.buildLeft <= 0 && b.owner > 0 && b.owner < counts.length) counts[b.owner]++;
  return state.players.map((p) => (p.id === 0 ? 0 : Math.floor(p.tiles + population(p) / 100 + counts[p.id] * 50)));
}

/** Alive player with the highest score (ties: lower id), or 0. */
function leader(state: GameState): number {
  const s = allScores(state);
  let best = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive) continue;
    if (best === 0 || s[p.id] > s[best]) best = p.id;
  }
  return best;
}

function endGame(state: GameState, winner: number, why: string): void {
  state.phase = 'over';
  state.winner = winner;
  const name = winner ? state.players[winner].name : 'Nobody';
  addEvent(state, 'victory', `${name} wins: ${why}`, winner ? [winner] : [], -1);
  const h = state.humanId;
  if (h && winner !== h) addEvent(state, 'defeat', `Defeat: ${name} wins (${why})`, [h], -1);
}

/** Sets phase 'over' and winner; 'victory'/'defeat' events. Also stats.tilesMax. Runs once per second. */
export function updateVictory(state: GameState): void {
  if (state.phase !== 'playing' || state.tick % TICKS_PER_SECOND !== 0) return;
  let alive = 0;
  let last = 0;
  for (const p of state.players) {
    if (p.id === 0) continue;
    if (p.tiles > p.stats.tilesMax) p.stats.tilesMax = p.tiles;
    if (p.alive) {
      alive++;
      last = p.id;
    }
  }

  // Human gone: the game ends for them.
  const h = state.humanId;
  if (h && !state.players[h].alive) {
    endGame(state, leader(state), `${state.players[h].name} was eliminated`);
    return;
  }

  const share = state.settings.victoryLandShare > 0 ? state.settings.victoryLandShare : VICTORY_LAND_SHARE;
  const need = share * state.map.landTileCount;
  for (const p of state.players) {
    if (p.id !== 0 && p.alive && p.tiles >= need) {
      endGame(state, p.id, `controls ${Math.round(share * 100)}% of the land`);
      return;
    }
  }
  if (alive === 1 && state.players.length > 2) {
    endGame(state, last, 'last nation standing');
    return;
  }
  if (alive === 0) {
    endGame(state, 0, 'every nation fell');
    return;
  }
  const limit = state.settings.timeLimit;
  if (limit > 0 && state.tick / TICKS_PER_SECOND >= limit) {
    endGame(state, leader(state), 'highest score when time ran out');
  }
}
