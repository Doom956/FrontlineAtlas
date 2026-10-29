// Times each simulation system of an AI-only game and prints per-system averages, maxima and tick percentiles.
// Usage: npx vite-node scripts/profile.ts -- [seed] [minutes] [mapSize] [aiCount]
import { updateAI } from '../src/sim/ai';
import { updateBuildings } from '../src/sim/buildings';
import { updateAttacks, updateSupply } from '../src/sim/combat';
import { VICTORY_LAND_SHARE } from '../src/sim/config';
import { updateDiplomacy } from '../src/sim/diplomacy';
import { updateEconomy } from '../src/sim/economy';
import { tick } from '../src/sim/sim';
import { createGame, pruneEliminated } from '../src/sim/state';
import { updateResearch } from '../src/sim/tech';
import type { GameState, MapSize } from '../src/sim/types';
import { updateUnits } from '../src/sim/units';
import { updateVictory } from '../src/sim/victory';

declare const process: { argv: string[] };

const args = process.argv.slice(2).filter((x) => x !== '--');
const seed = Number(args[0] ?? 4) || 4;
const minutes = Number(args[1] ?? 10) || 10;
const mapSize = (['small', 'medium', 'large'].includes(args[2]) ? args[2] : 'large') as MapSize;
const aiCount = Math.max(2, Math.min(15, Number(args[3] ?? 15) || 15));

const state = createGame({
  seed,
  mapType: 'continents',
  mapSize,
  aiCount,
  difficulty: 'normal',
  playerName: 'Nobody',
  playerColor: [255, 255, 255],
  humanPlayer: false,
  timeLimit: 0,
  victoryLandShare: VICTORY_LAND_SHARE,
});

// Same order as sim.tick (playing phase).
const systems: [string, (s: GameState) => void][] = [
  ['economy', updateEconomy],
  ['research', updateResearch],
  ['buildings', updateBuildings],
  ['supply', updateSupply],
  ['attacks', updateAttacks],
  ['prune', pruneEliminated],
  ['units', updateUnits],
  ['prune2', pruneEliminated],
  ['diplomacy', updateDiplomacy],
  ['ai', updateAI],
  ['victory', updateVictory],
];
const total: Record<string, number> = {};
const worst: Record<string, number> = {};
const perTick: number[] = [];

while (state.phase === 'spawn') tick(state);
const ticks = minutes * 600;
for (let k = 0; k < ticks && state.phase === 'playing'; k++) {
  const t0 = performance.now();
  for (const [name, fn] of systems) {
    const a = performance.now();
    fn(state);
    const d = performance.now() - a;
    total[name] = (total[name] ?? 0) + d;
    worst[name] = Math.max(worst[name] ?? 0, d);
  }
  state.tick++;
  state.events.length = 0;
  perTick.push(performance.now() - t0);
}

perTick.sort((a, b) => a - b);
const pct = (q: number): string => perTick[Math.min(perTick.length - 1, Math.floor(perTick.length * q))].toFixed(2);
console.log(`${mapSize} map, ${aiCount} AIs, ${perTick.length} ticks: p50 ${pct(0.5)} ms, p99 ${pct(0.99)} ms, p99.9 ${pct(0.999)} ms`);
for (const [name] of systems) {
  console.log(`${name.padEnd(10)} avg ${(total[name] / perTick.length).toFixed(3)} ms   max ${worst[name].toFixed(1)} ms`);
}
