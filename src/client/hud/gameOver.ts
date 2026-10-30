// End screen: victory or defeat, your place and a few numbers, play again.
import { gameSeconds } from '../../sim/state';
import type { GameState, Player } from '../../sim/types';
import { teamOf } from '../../sim/rules';
import { allScores, teamName } from '../../sim/victory';
import { isTribe } from '../compat';
import { swatchCss } from './swatch';
import { formatCount } from '../render/common';
import { btn, el, fmtTime } from './dom';

/**
 * The game-over card. `me` is the client's nation; a spectator passes the neutral entry (id 0) and gets the result
 * without a victory / defeat verdict or personal numbers.
 */
export function gameOverCard(state: GameState, me: Player, onAgain: () => void, onMenu: () => void, onLook: () => void, againLabel = 'Play again'): HTMLElement {
  const watcher = me.id === 0;
  const won = !watcher && (state.winner === me.id || (state.winnerTeam > 0 && teamOf(state, me.id) === state.winnerTeam));
  const winner = state.players[state.winner];
  const card = el('div', 'over-card');
  card.append(el('div', 'wr-sec', watcher ? 'Final result' : won ? 'Mission complete' : 'Mission failed'));
  card.append(el('h1', watcher ? 'over-t' : won ? 'over-t win' : 'over-t lose', watcher ? 'Game over' : won ? 'Victory' : 'Defeat'));
  const sub = el('p', 'over-sub');
  // Every human was eliminated: nobody reached a win condition, the "winner" is only the nation leading the map.
  const allHumansOut = state.players.some((p) => p.isHuman) && state.players.every((p) => !p.isHuman || !p.alive);
  if (allHumansOut && !won) {
    const lead = winner && state.winner ? ` ${state.winnerTeam > 0 ? `${teamName(state.winnerTeam)} (${winner.name})` : winner.name} leads the map.` : '';
    sub.append(watcher ? `Every player was eliminated.${lead}` : `You were eliminated: your nation is gone.${lead}`);
  } else if (winner && state.winner) {
    const dot = el('i', 'sw');
    dot.style.background = swatchCss(winner, state.humanId);
    const team = state.winnerTeam > 0 ? `${teamName(state.winnerTeam)} (led by ${winner.name})` : '';
    sub.append(dot, won ? (team ? `Your team rules the map: ${team}.` : 'Your nation rules the map.') : team ? `${team} wins.` : `${winner.name} wins.`);
  } else sub.append('Nobody wins.');
  card.append(sub);
  const scores = allScores(state);
  const ranked = state.players.filter((p) => p.id !== 0 && !isTribe(p)).sort((a, b) => scores[b.id] - scores[a.id]);
  const place = ranked.findIndex((p) => p.id === me.id) + 1;
  const st = me.stats;
  const big = el('div', 'over-big');
  const cell = (v: string, k: string) => {
    const c = el('div');
    c.append(el('span', 'big-v', v), el('span', 'big-l', k));
    big.append(c);
  };
  if (!watcher) {
    cell(`#${place}`, `of ${ranked.length}`);
    cell(formatCount(scores[me.id]), 'score');
  } else cell(String(ranked.length), 'nations');
  cell(fmtTime(gameSeconds(state)), 'game time');
  card.append(big);
  const grid = el('div', 'stats');
  const rows: [string, string][] = [
    ['Most land', `${formatCount(st.tilesMax)} tiles (${((st.tilesMax / Math.max(1, state.map.landTileCount)) * 100).toFixed(1)}%)`],
    ['Tiles captured', formatCount(st.tilesCaptured)],
    ['Enemy troops killed', formatCount(st.troopsKilled)],
    ['Troops lost', formatCount(st.troopsLost)],
    ['Buildings built', formatCount(st.buildingsBuilt)],
    ['Gold earned', formatCount(st.goldEarned)],
  ];
  for (const [k, v] of rows) grid.append(el('span', 'k', k), el('span', 'v', v));
  if (!watcher) card.append(grid);
  const btns = el('div', 'over-btns');
  const again = btn(againLabel, 'primary big', onAgain);
  again.dataset.test = 'play-again';
  btns.append(again, btn('Main menu', 'big', onMenu), btn('Look at the map', 'big ghost', onLook));
  card.append(btns);
  return card;
}
