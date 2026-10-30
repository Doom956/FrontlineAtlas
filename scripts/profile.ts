// Times each simulation system of an AI-only game and prints per-system averages, maxima and tick percentiles.
// Usage: npx vite-node scripts/profile.ts -- [seed] [minutes] [mapSize] [aiCount] [tribes]
//    or: npx vite-node scripts/profile.ts -- --size huge --ai 50 --tribes 300 --minutes 20 --seed 4 --map continents
// Defaults: seed 4, 10 minutes, large map, the menu defaults for AIs and tribes of that size.
import { cloneSetup, DEFAULT_SETUP } from '../src/sim/setup';
import { updateAdvisor } from '../src/sim/advisor';
import { updateAI } from '../src/sim/ai';
import { updateBarrages } from '../src/sim/barrage';
import { updateBuildings } from '../src/sim/buildings';
import { updateAttacks, updateSupply } from '../src/sim/combat';
import { DEFAULT_AI_COUNT, DEFAULT_TRIBE_COUNT, MAX_AI_COUNT, MAX_TRIBE_COUNT, VICTORY_LAND_SHARE } from '../src/sim/config';
import { updateDiplomacy } from '../src/sim/diplomacy';
import { updateEconomy } from '../src/sim/economy';
import { updateEndgame } from '../src/sim/endgame';
import { tick } from '../src/sim/sim';
import { createGame, pruneEliminated } from '../src/sim/state';
import { updateResearch } from '../src/sim/tech';
import { isTribe } from '../src/sim/types';
import type { GameState, MapSize, MapType } from '../src/sim/types';
import { updateUnits } from '../src/sim/units';
import { updateVictory } from '../src/sim/victory';

declare const process: { argv: string[]; memoryUsage(): { heapUsed: number; rss: number } };

const SIZES: MapSize[] = ['small', 'medium', 'large', 'huge'];
const raw = process.argv.slice(2).filter((x) => x !== '--');
const flags: Record<string, string> = {};
const pos: string[] = [];
for (let k = 0; k < raw.length; k++) {
  if (raw[k].startsWith('--')) flags[raw[k].slice(2)] = raw[++k] ?? '';
  else pos.push(raw[k]);
}
const seed = Number(flags.seed ?? pos[0] ?? 4) || 4;
const minutes = Number(flags.minutes ?? pos[1] ?? 10) || 10;
const sizeArg = flags.size ?? pos[2];
const mapSize = (SIZES.includes(sizeArg as MapSize) ? sizeArg : 'large') as MapSize;
const aiArg = flags.ai ?? pos[3];
const aiCount = Math.max(2, Math.min(MAX_AI_COUNT, aiArg !== undefined ? Number(aiArg) || 2 : DEFAULT_AI_COUNT[mapSize]));
const tribeArg = flags.tribes ?? pos[4];
const tribeCount = tribeArg !== undefined ? Math.max(0, Math.min(MAX_TRIBE_COUNT, Number(tribeArg) || 0)) : DEFAULT_TRIBE_COUNT[mapSize];
const mapType = (flags.map ?? 'continents') as MapType;

const t0 = performance.now();
const state = createGame({
  ...cloneSetup(DEFAULT_SETUP),
  seed,
  map: { kind: 'generated', type: mapType, size: mapSize },
  aiCount,
  difficulty: 'normal',
  playerName: 'Nobody',
  playerColor: [255, 255, 255],
  humanPlayer: false,
  timeLimit: 0,
  victoryLandShare: VICTORY_LAND_SHARE,
  tribeCount,
});
const createMs = performance.now() - t0;

// Same order as sim.tick (playing phase).
const systems: [string, (s: GameState) => void][] = [
  ['economy', updateEconomy],
  ['research', updateResearch],
  ['buildings', updateBuildings],
  ['supply', updateSupply],
  ['attacks', updateAttacks],
  ['endgame', updateEndgame],
  ['prune', pruneEliminated],
  ['units', updateUnits],
  ['barrages', updateBarrages],
  ['prune2', pruneEliminated],
  ['diplomacy', updateDiplomacy],
  ['ai', updateAI],
  ['advisor', updateAdvisor],
  ['victory', updateVictory],
];
const total: Record<string, number> = {};
const worst: Record<string, number> = {};
const perTick: number[] = [];

const s0 = performance.now();
while (state.phase === 'spawn') tick(state);
const spawnMs = performance.now() - s0;
const ticks = minutes * 600;
let maxArmy = 0;
let maxTiles = 0;
for (let k = 0; k < ticks && state.phase === 'playing'; k++) {
  const t1 = performance.now();
  for (const [name, fn] of systems) {
    const a = performance.now();
    fn(state);
    const d = performance.now() - a;
    total[name] = (total[name] ?? 0) + d;
    worst[name] = Math.max(worst[name] ?? 0, d);
  }
  state.tick++;
  state.events.length = 0;
  state.effects.length = 0;
  perTick.push(performance.now() - t1);
  if (k % 600 === 599) {
    let army = 0;
    for (const p of state.players) {
      if (!p.alive || isTribe(p) || p.id === 0) continue;
      let a = p.troops.infantry + p.troops.armor + p.troops.artillery;
      for (const at of state.attacks) if (at.attacker === p.id) a += at.troops.infantry + at.troops.armor + at.troops.artillery;
      army = Math.max(army, a);
      maxTiles = Math.max(maxTiles, p.tiles);
    }
    maxArmy = Math.max(maxArmy, army);
    const alive = state.players.filter((p) => p.alive && p.id !== 0 && !isTribe(p)).length;
    const tribes = state.players.filter((p) => p.alive && isTribe(p)).length;
    let owned = 0;
    for (const p of state.players) if (p.id !== 0) owned += p.tiles;
    console.log(
      `  min ${((k + 1) / 600).toFixed(0)}: biggest army ${Math.round(army).toLocaleString()}, biggest nation ${maxTiles} tiles, ` +
        `owned ${((100 * owned) / state.map.landTileCount).toFixed(0)}% of the land, nations ${alive}, tribes ${tribes}, attacks ${state.attacks.length}`,
    );
  }
}

perTick.sort((a, b) => a - b);
const pct = (q: number): string => perTick[Math.min(perTick.length - 1, Math.floor(perTick.length * q))].toFixed(2);
const mem = process.memoryUsage();
console.log(
  `${mapSize} ${mapType} map (${state.map.width}x${state.map.height}, ${state.map.landTileCount} land), ${aiCount} AIs, ${tribeCount} tribes, ${perTick.length} ticks: ` +
    `p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms, max ${perTick[perTick.length - 1].toFixed(1)} ms`,
);
console.log(`createGame ${createMs.toFixed(0)} ms, spawn phase ${spawnMs.toFixed(0)} ms, heap ${(mem.heapUsed / 1e6).toFixed(0)} MB, rss ${(mem.rss / 1e6).toFixed(0)} MB, phase ${state.phase}, winner ${state.winner}`);
console.log(`max army ${Math.round(maxArmy).toLocaleString()}, max nation ${maxTiles} tiles`);
for (const [name] of systems) {
  console.log(`${name.padEnd(10)} avg ${((total[name] ?? 0) / perTick.length).toFixed(3)} ms   max ${(worst[name] ?? 0).toFixed(1)} ms`);
}
