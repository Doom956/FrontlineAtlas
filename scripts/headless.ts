// Runs AI-only games without a browser and prints stats.
// Usage: npx vite-node scripts/headless.ts -- [seed] [minutes] [mapSize] [aiCount] [mapType] [tribes]
//    or: npm run headless -- [seed] [minutes] [mapSize] [aiCount] [mapType] [tribes]
// aiCount and tribes default to the menu defaults for the map size (config DEFAULT_AI_COUNT / DEFAULT_TRIBE_COUNT).
import { DEFAULT_AI_COUNT, MAX_AI_COUNT, TICKS_PER_SECOND, VICTORY_LAND_SHARE } from '../src/sim/config';
import { armyTotal, population } from '../src/sim/economy';
import { isTribe } from '../src/sim/types';
import { tick } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import { allScores } from '../src/sim/victory';
import type { GameSettings, GameState, MapSize, MapType } from '../src/sim/types';

// No @types/node in this project: declare the one Node global we use.
declare const process: { argv: string[] };

const args = process.argv.slice(2).filter((a) => a !== '--');
const seed = Number(args[0] ?? 1) || 1;
const minutes = Number(args[1] ?? 20) || 20;
const mapSize = (['small', 'medium', 'large', 'huge'].includes(args[2]) ? args[2] : 'medium') as MapSize;
const aiCount = Math.max(2, Math.min(MAX_AI_COUNT, Number(args[3] ?? DEFAULT_AI_COUNT[mapSize]) || DEFAULT_AI_COUNT[mapSize]));
const mapType = (['continents', 'pangaea', 'archipelago', 'highlands'].includes(args[4]) ? args[4] : 'continents') as MapType;
const tribeCount = args[5] !== undefined && Number.isFinite(Number(args[5])) ? Math.max(0, Number(args[5])) : -1;

const settings: GameSettings = {
  seed,
  mapType,
  mapSize,
  aiCount,
  difficulty: 'normal',
  playerName: 'Nobody',
  playerColor: [255, 255, 255],
  humanPlayer: false,
  timeLimit: 0,
  victoryLandShare: VICTORY_LAND_SHARE,
  tribeCount,
};

function pad(v: string | number, n: number): string {
  const s = String(v);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
function fmt(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  return Math.round(v).toString();
}
function countBuildings(state: GameState): number[] {
  const c = new Array<number>(state.players.length).fill(0);
  for (const b of state.buildings.values()) if (b.owner > 0 && b.owner < c.length) c[b.owner]++;
  return c;
}

function printTable(state: GameState): void {
  const mins = (state.tick / TICKS_PER_SECOND / 60).toFixed(1);
  console.log(`\n--- t = ${mins} min (tick ${state.tick}, phase ${state.phase}) ---`);
  console.log(
    ['id', 'name', 'pers', 'tiles', 'troops', 'inf', 'arm', 'art', 'mix%', 'gold', 'iron', 'oil', 'tech', 'bld', 'score']
      .map((h, k) => (k === 1 ? h.padEnd(16) : k === 2 ? h.padEnd(9) : pad(h, 7)))
      .join(' '),
  );
  const bld = countBuildings(state);
  const scores = allScores(state);
  const rows = state.players.filter((p) => p.id !== 0 && !isTribe(p)).sort((a, b) => b.tiles - a.tiles);
  for (const p of rows) {
    console.log(
      [
        pad(p.id, 7),
        (p.name.slice(0, p.alive ? 16 : 12) + (p.alive ? '' : ' (x)')).padEnd(16),
        (p.personality ?? '-').padEnd(9),
        pad(p.tiles, 7),
        pad(fmt(population(p)), 7),
        pad(fmt(p.troops.infantry), 7),
        pad(fmt(p.troops.armor), 7),
        pad(fmt(p.troops.artillery), 7),
        pad(mixText(p), 7),
        pad(fmt(p.gold), 7),
        pad(fmt(p.iron), 7),
        pad(fmt(p.oil), 7),
        pad(p.techs.length, 7),
        pad(bld[p.id], 7),
        pad(scores[p.id], 7),
      ].join(' '),
    );
  }
  const tribes = state.players.filter((p) => isTribe(p));
  if (tribes.length) {
    const alive = tribes.filter((p) => p.alive);
    const tiles = alive.reduce((n, p) => n + p.tiles, 0);
    console.log(`tribes: ${alive.length}/${tribes.length} alive, ${tiles} tiles`);
  }
}
/** Armor / artillery share of the army in whole percent, e.g. "22/14". */
function mixText(p: GameState['players'][number]): string {
  const t = armyTotal(p.troops);
  if (t <= 0) return '-';
  return `${Math.round((100 * p.troops.armor) / t)}/${Math.round((100 * p.troops.artillery) / t)}`;
}

const t0 = performance.now();
const state = createGame(settings);
const tGen = performance.now() - t0;
console.log(
  `Borderfall headless: seed ${seed}, ${mapType} ${mapSize} ${state.map.width}x${state.map.height}, ` +
    `${aiCount} AIs, ${minutes} min. Land ${state.map.landTileCount} tiles. Map generated in ${tGen.toFixed(0)} ms.`,
);

const totalTicks = Math.round(minutes * 60 * TICKS_PER_SECOND);
const reportEvery = 2 * 60 * TICKS_PER_SECOND;
let tickMs = 0;
let worstTick = 0;
let ran = 0;
for (let k = 0; k < totalTicks && state.phase !== 'over'; k++) {
  const a = performance.now();
  tick(state);
  const dt = performance.now() - a;
  tickMs += dt;
  if (dt > worstTick) worstTick = dt;
  ran++;
  if (state.tick % reportEvery === 0) printTable(state);
  state.events.length = 0; // nobody drains events here
}
printTable(state);

// Army mix of the surviving nations (troops at home), weighted by army size.
{
  let inf = 0;
  let arm = 0;
  let art = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || isTribe(p)) continue;
    inf += p.troops.infantry;
    arm += p.troops.armor;
    art += p.troops.artillery;
  }
  const t = Math.max(1, inf + arm + art);
  console.log(`\nArmy mix of surviving nations: infantry ${((100 * inf) / t).toFixed(1)}%, armor ${((100 * arm) / t).toFixed(1)}%, artillery ${((100 * art) / t).toFixed(1)}%`);
}
const winner = state.winner ? state.players[state.winner] : null;
if (winner) console.log(`\nWinner: ${winner.name} (id ${winner.id}) at ${(state.tick / TICKS_PER_SECOND / 60).toFixed(1)} min`);
else {
  const scores = allScores(state);
  const lead = state.players.filter((p) => p.alive && p.id !== 0).sort((a, b) => scores[b.id] - scores[a.id])[0];
  console.log(`\nNo winner after ${minutes} min. Leader: ${lead ? `${lead.name} (score ${scores[lead.id]})` : 'none'}`);
}
console.log(`Ticks: ${ran}, ${(tickMs / Math.max(1, ran)).toFixed(3)} ms/tick average, worst ${worstTick.toFixed(1)} ms.`);
