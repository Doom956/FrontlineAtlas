// What the end-of-game summary shows, from the game state and its GameHistory (no DOM, so it is testable):
// the nations on the chart (you, the top 5, the rest faded), the 5-8 key moments and the stats table's columns.
import { gameSeconds, gameSecondsAt } from '../../sim/state';
import { allScores } from '../../sim/victory';
import { isTribe, type GameState, type Player } from '../../sim/types';
import { KIND_WEIGHT, type GameHistory, type Moment } from './history';

/** nations drawn in colour besides yours */
export const TOP_NATIONS = 5;
/** key moments on the timeline */
export const MAX_MOMENTS_SHOWN = 8;
/** nation columns in the stats table */
export const TABLE_COLUMNS = 4;

export type SeriesRole = 'me' | 'top' | 'faded';

export interface Series {
  id: number;
  name: string;
  role: SeriesRole;
  /** [game seconds, share of the land 0..1]; ends at the nation's elimination */
  points: [number, number][];
}

export interface StatColumn {
  id: number;
  name: string;
  /** "You", "Winner", "You · Winner", "#3" */
  tag: string;
  landPeak: number;
  battlesWon: number;
  cities: number;
  unitsBuilt: number;
  goldEarned: number;
  /** seconds */
  alive: number;
  eliminated: boolean;
}

export interface SummaryData {
  duration: number;
  /** the winner's id (0 = none) */
  winner: number;
  /** the win line (settings.victoryLandShare) */
  victoryShare: number;
  series: Series[];
  moments: Moment[];
  columns: StatColumn[];
}

const nations = (state: GameState): Player[] => state.players.filter((p) => p.id > 0 && !isTribe(p));

/** Nations by final score, best first (the order of the game-over card's place). */
export function rankNations(state: GameState): Player[] {
  const scores = allScores(state);
  return nations(state).sort((a, b) => scores[b.id] - scores[a.id] || a.id - b.id);
}

/** The land-over-time lines: faded ones first so yours and the top nations draw on top. */
export function buildSeries(state: GameState, h: GameHistory, me: number, top: number[]): Series[] {
  const land = Math.max(1, state.map.landTileCount);
  const out: Series[] = [];
  for (const p of nations(state)) {
    const role: SeriesRole = p.id === me ? 'me' : top.includes(p.id) ? 'top' : 'faded';
    const points: [number, number][] = [];
    let was = false;
    for (const s of h.samples) {
      const v = s.tiles[p.id] ?? 0;
      if (v > 0) was = true;
      else if (was) {
        points.push([s.t, 0]); // the fall to zero, then the line stops
        break;
      }
      if (was) points.push([s.t, v / land]);
    }
    if (points.length) out.push({ id: p.id, name: p.name, role, points });
  }
  // faded first, then the top nations (last place first), yours last: drawn in this order, the best on top
  const order: Record<SeriesRole, number> = { faded: 0, top: 1, me: 2 };
  return out.sort((a, b) => order[a.role] - order[b.role] || top.indexOf(b.id) - top.indexOf(a.id));
}

/** The winner first reaching half the land, from the samples (none if it never did). */
export function halfMoment(state: GameState, h: GameHistory): Moment | null {
  const w = state.winner;
  const at = w > 0 ? h.halfAt[w] ?? -1 : -1;
  if (at < 0) return null;
  const who = w === state.humanId ? 'You hold' : `${state.players[w].name} holds`;
  return { t: at, kind: 'half', text: `${who} half the land`, players: [w] };
}

/**
 * The 5-8 moments worth a marker: by importance (kind, then yours, the winner's, the top nations'), never two
 * crowded together on the timeline, returned in time order.
 */
export function pickMoments(all: Moment[], duration: number, me: number, winner: number, top: number[], max = MAX_MOMENTS_SHOWN): Moment[] {
  const weight = (m: Moment) => {
    let w = KIND_WEIGHT[m.kind];
    if (me > 0 && m.players.includes(me)) w += 40;
    if (winner > 0 && m.players.includes(winner)) w += 15;
    if (m.players.some((p) => top.includes(p))) w += 8;
    return w;
  };
  const ranked = all.map((m, i) => ({ m, w: weight(m), i })).sort((a, b) => b.w - a.w || a.m.t - b.m.t || a.i - b.i);
  const gap = Math.max(1, duration / 40);
  const picked: Moment[] = [];
  for (const { m } of ranked) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.abs(p.t - m.t) < gap)) continue;
    picked.push(m);
  }
  return picked.sort((a, b) => a.t - b.t);
}

function column(state: GameState, h: GameHistory, p: Player, tag: string): StatColumn {
  const land = Math.max(1, state.map.landTileCount);
  const end = gameSeconds(state);
  return {
    id: p.id,
    name: p.name,
    tag,
    landPeak: p.stats.tilesMax / land,
    battlesWon: h.battlesWon[p.id] ?? 0,
    cities: h.citiesMax[p.id] ?? 0,
    unitsBuilt: h.unitsBuilt[p.id] ?? 0,
    goldEarned: p.stats.goldEarned,
    alive: !p.alive && p.eliminatedTick >= 0 ? Math.min(end, gameSecondsAt(state, p.eliminatedTick)) : end,
    eliminated: !p.alive,
  };
}

/** Table columns: you, the winner, then the best-placed nations (TABLE_COLUMNS in all). */
export function buildColumns(state: GameState, h: GameHistory, me: number, ranked: Player[]): StatColumn[] {
  const winner = state.winner;
  const cols: StatColumn[] = [];
  const add = (p: Player | undefined) => {
    if (!p || cols.length >= TABLE_COLUMNS || cols.some((c) => c.id === p.id)) return;
    const place = ranked.findIndex((r) => r.id === p.id) + 1;
    const tags: string[] = [];
    if (p.id === me) tags.push('You');
    if (p.id === winner) tags.push('Winner');
    cols.push(column(state, h, p, tags.length ? tags.join(' · ') : `#${place}`));
  };
  add(me > 0 ? state.players[me] : undefined);
  add(winner > 0 ? state.players[winner] : undefined);
  for (const p of ranked) add(p);
  return cols;
}

export function buildSummary(state: GameState, h: GameHistory): SummaryData {
  const me = state.humanId;
  const ranked = rankNations(state);
  const top = ranked.filter((p) => p.id !== me).slice(0, TOP_NATIONS).map((p) => p.id);
  const duration = Math.max(h.duration, gameSeconds(state));
  const half = halfMoment(state, h);
  const all = half ? [...h.moments, half] : h.moments;
  return {
    duration,
    winner: state.winner,
    victoryShare: state.settings.victoryLandShare,
    series: buildSeries(state, h, me, top),
    moments: pickMoments(all, duration, me, state.winner, top),
    columns: buildColumns(state, h, me, ranked),
  };
}
