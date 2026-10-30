// End screen: victory or defeat, your place and a few numbers, play again.
import { gameSeconds } from '../../sim/state';
import type { GameState, Player } from '../../sim/types';
import { allScores } from '../../sim/victory';
import { rgbCss } from '../menu';
import { formatCount } from '../render/common';
import { btn, el, fmtTime } from './dom';

export function gameOverCard(state: GameState, me: Player, onAgain: () => void, onMenu: () => void, onLook: () => void): HTMLElement {
  const won = state.winner === me.id;
  const winner = state.players[state.winner];
  const card = el('div', 'over-card');
  card.append(el('div', 'wr-sec', won ? 'Mission complete' : 'Mission failed'));
  card.append(el('h1', won ? 'over-t win' : 'over-t lose', won ? 'Victory' : 'Defeat'));
  const sub = el('p', 'over-sub');
  if (winner && state.winner) {
    const dot = el('i', 'sw');
    dot.style.background = rgbCss(winner.color);
    sub.append(dot, won ? 'Your nation rules the map.' : `${winner.name} wins.`);
  } else sub.append('Nobody wins.');
  card.append(sub);
  const scores = allScores(state);
  const ranked = state.players.filter((p) => p.id !== 0).sort((a, b) => scores[b.id] - scores[a.id]);
  const place = ranked.findIndex((p) => p.id === me.id) + 1;
  const st = me.stats;
  const big = el('div', 'over-big');
  const cell = (v: string, k: string) => {
    const c = el('div');
    c.append(el('span', 'big-v', v), el('span', 'big-l', k));
    big.append(c);
  };
  cell(`#${place}`, `of ${ranked.length}`);
  cell(formatCount(scores[me.id]), 'score');
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
  card.append(grid);
  const btns = el('div', 'over-btns');
  const again = btn('Play again', 'primary big', onAgain);
  again.dataset.test = 'play-again';
  btns.append(again, btn('Main menu', 'big', onMenu), btn('Look at the map', 'big ghost', onLook));
  card.append(btns);
  return card;
}
