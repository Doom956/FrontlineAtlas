// Win/lose detection and scores.
import { OVERTIME_DROP_PER_MINUTE, OVERTIME_MIN_SHARE, OVERTIME_MINUTES, TICKS_PER_SECOND, VICTORY_LAND_SHARE } from './config';
import { population } from './economy';
import { addEvent, gameSeconds } from './state';
import { isTeamGame, teamOf } from './rules';
import { isTribe } from './types';
import type { GameState } from './types';

/**
 * Land share needed to win right now: the game's setting (VICTORY_LAND_SHARE by default); in overtime (after
 * OVERTIME_MINUTES) it drops by OVERTIME_DROP_PER_MINUTE per full minute, down to OVERTIME_MIN_SHARE (never up).
 */
export function victoryShareNow(state: GameState): number {
  const base = state.settings.victoryLandShare > 0 ? state.settings.victoryLandShare : VICTORY_LAND_SHARE;
  const minutes = gameSeconds(state) / 60;
  if (minutes < OVERTIME_MINUTES + 1) return base;
  const floor = Math.min(base, OVERTIME_MIN_SHARE);
  return Math.max(floor, base - OVERTIME_DROP_PER_MINUTE * Math.floor(minutes - OVERTIME_MINUTES));
}
/** True once overtime has started (the needed land share is falling). */
export function inOvertime(state: GameState): boolean {
  return state.phase !== 'spawn' && gameSeconds(state) / 60 >= OVERTIME_MINUTES;
}

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

/** Alive nation (not a tribe) with the highest score (ties: lower id), or 0; in a team game the best member of the best team. */
function leader(state: GameState): number {
  const s = allScores(state);
  if (isTeamGame(state)) {
    const teamScore = new Map<number, number>();
    for (const p of state.players) {
      const t = teamOf(state, p.id);
      if (p.id === 0 || !p.alive || isTribe(p) || t <= 0) continue;
      teamScore.set(t, (teamScore.get(t) ?? 0) + s[p.id]);
    }
    let bestTeam = 0;
    for (const [t, v] of teamScore) if (bestTeam === 0 || v > teamScore.get(bestTeam)! || (v === teamScore.get(bestTeam) && t < bestTeam)) bestTeam = t;
    if (bestTeam > 0) return bestMember(state, bestTeam, s);
  }
  let best = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || isTribe(p)) continue;
    if (best === 0 || s[p.id] > s[best]) best = p.id;
  }
  return best;
}

/** Best-scoring alive member of a team (ties: lower id), or 0. */
function bestMember(state: GameState, team: number, s = allScores(state)): number {
  let best = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || isTribe(p) || teamOf(state, p.id) !== team) continue;
    if (best === 0 || s[p.id] > s[best]) best = p.id;
  }
  return best;
}

export function teamName(team: number): string {
  return `Team ${team}`;
}

/**
 * Ends the game. `leading`: nobody reached a win condition (every human was eliminated): `winner` is only the
 * leader at that moment and the texts say so instead of naming a winner.
 */
function endGame(state: GameState, winner: number, why: string, leading = false): void {
  state.phase = 'over';
  state.winner = winner;
  const team = winner && isTeamGame(state) ? teamOf(state, winner) : 0;
  state.winnerTeam = team;
  const name = team ? `${teamName(team)} (${state.players[winner].name})` : winner ? state.players[winner].name : 'Nobody';
  const verb = team ? 'win' : 'wins';
  const head = leading ? `${why}; ${name} ${team ? 'lead' : 'leads'} the map` : `${name} ${verb}: ${why}`;
  addEvent(state, 'victory', head, winner ? [winner] : [], -1);
  // A 'defeat' event for every human who didn't win (the client shows the ones about its own player).
  for (const p of state.players) {
    if (!p.isHuman || p.id === 0) continue;
    const won = winner === p.id || (team > 0 && teamOf(state, p.id) === team);
    if (won) continue;
    const text = leading ? (p.alive ? `Defeat: ${head}` : `Defeat: ${p.name} was eliminated (${name} ${team ? 'lead' : 'leads'} the map)`) : `Defeat: ${name} ${verb} (${why})`;
    addEvent(state, 'defeat', text, [p.id], -1);
  }
}

/** True when player `id` (default: the client's own, state.humanId) won, alone or with their team. */
export function humanWon(state: GameState, id = state.humanId): boolean {
  if (!id || state.phase !== 'over') return false;
  return state.winner === id || (state.winnerTeam > 0 && teamOf(state, id) === state.winnerTeam);
}

/**
 * Sets phase 'over' and winner; 'victory'/'defeat' events. Also stats.tilesMax. Runs once per second.
 * The game also ends when every human is eliminated (single player: the human).
 * Tribes never win and don't count for 'last nation standing'. In a team game a team wins together: by its members'
 * land added up, or as the last team standing (`winner` = its best-scoring member, `winnerTeam` = the team).
 */
export function updateVictory(state: GameState): void {
  if (state.phase !== 'playing' || state.tick % TICKS_PER_SECOND !== 0) return;
  let alive = 0;
  let last = 0;
  let nations = 0;
  const teamGame = isTeamGame(state);
  const teamTiles = new Map<number, number>();
  for (const p of state.players) {
    if (p.id === 0) continue;
    if (p.tiles > p.stats.tilesMax) p.stats.tilesMax = p.tiles;
    if (isTribe(p)) continue;
    nations++;
    if (p.alive) {
      alive++;
      last = p.id;
      const t = teamGame ? teamOf(state, p.id) : 0;
      if (t > 0) teamTiles.set(t, (teamTiles.get(t) ?? 0) + p.tiles);
    }
  }

  // Every human gone (single player: the one human): the game ends. In a multiplayer game an eliminated player
  // only becomes a spectator while other humans play on. Never depends on which human a client controls.
  let humans = 0;
  let humansAlive = 0;
  let lastHuman = 0;
  for (const p of state.players) {
    if (!p.isHuman || p.id === 0) continue;
    humans++;
    if (p.alive) humansAlive++;
    else if (lastHuman === 0 || p.eliminatedTick > state.players[lastHuman].eliminatedTick) lastHuman = p.id;
  }
  if (humans > 0 && humansAlive === 0) {
    const why = humans === 1 ? `${state.players[lastHuman].name} was eliminated` : 'every player was eliminated';
    endGame(state, leader(state), why, true);
    return;
  }

  const share = victoryShareNow(state);
  const need = share * state.map.landTileCount;
  if (teamGame) {
    for (const [t, tiles] of teamTiles) {
      if (tiles >= need) {
        endGame(state, bestMember(state, t), `the team controls ${Math.round(share * 100)}% of the land`);
        return;
      }
    }
    if (teamTiles.size === 1 && nations > 1) {
      const [t] = teamTiles.keys();
      const allTeamed = state.players.every((p) => p.id === 0 || !p.alive || isTribe(p) || teamOf(state, p.id) > 0);
      if (allTeamed) {
        endGame(state, bestMember(state, t), 'last team standing');
        return;
      }
    }
  } else {
    for (const p of state.players) {
      if (p.id !== 0 && p.alive && !isTribe(p) && p.tiles >= need) {
        endGame(state, p.id, `controls ${Math.round(share * 100)}% of the land`);
        return;
      }
    }
  }
  if (alive === 1 && nations > 1) {
    endGame(state, last, 'last nation standing');
    return;
  }
  if (alive === 0) {
    endGame(state, 0, 'every nation fell');
    return;
  }
  const limit = state.settings.timeLimit;
  if (limit > 0 && gameSeconds(state) >= limit) {
    endGame(state, leader(state), 'highest score when time ran out');
  }
}
