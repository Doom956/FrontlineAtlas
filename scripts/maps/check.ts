// Plays an AI-only game on a real-world map and checks it is playable.
//   npx vite-node scripts/maps/check.ts -- <map id> [minutes=8] [nations=recommended] [seed=1]
// Checks: every spawn is on land; each spawn's landmass is big enough to grow on; iron and oil within reach of each
// spawn (by land, or on the same coast for islands); land tiles no nation could ever reach (lakes of land cut off by
// mountains are fine, land unreachable by both land and sea is not); then plays the game and reports how far nations got.
// Prints PROBLEM lines for anything wrong and a final "CHECK <id> OK" or "CHECK <id> PROBLEMS n".
import { TICKS_PER_SECOND } from '../../src/sim/config';
import { cloneSetup, DEFAULT_SETUP } from '../../src/sim/setup';
import { tick } from '../../src/sim/sim';
import { createGame } from '../../src/sim/state';
import { isTribe } from '../../src/sim/types';
import type { GameSettings } from '../../src/sim/types';
import { getWorldMap, loadWorldMap, worldMapSpawns } from '../../src/sim/worldmaps';

declare const process: { argv: string[]; exit(code: number): never };

const T_SHALLOW = 1;
const T_MOUNTAINS = 5;
const R_IRON = 1;
const R_OIL = 2;
const MIN_LANDMASS = 400; // land tiles a spawn's island needs to be worth starting on

const args = process.argv.slice(2).filter((a) => a !== '--');
const id = args[0];
if (!id) {
  console.error('usage: check.ts <map id> [minutes] [nations] [seed]');
  process.exit(2);
}
const info = getWorldMap(id);
if (!info) {
  console.error(`unknown map ${id}`);
  process.exit(2);
}
const minutes = Number(args[1] ?? 8) || 8;
const nations = Number(args[2] ?? info.recommendedNations) || info.recommendedNations;
const seed = Number(args[3] ?? 1) || 1;

const map = await loadWorldMap(id);
const W = map.width;
const H = map.height;
const N = W * H;
const terrain = map.terrain;
const resource = map.resource;
const problems: string[] = [];
const problem = (s: string): void => {
  problems.push(s);
  console.log(`PROBLEM ${s}`);
};

// landmasses (4-connected land, mountains included: they are land, just slow)
const mass = new Int32Array(N).fill(-1);
const massSize: number[] = [];
const stack: number[] = [];
for (let t = 0; t < N; t++) {
  if (terrain[t] <= T_SHALLOW || mass[t] >= 0) continue;
  const m = massSize.length;
  let size = 0;
  mass[t] = m;
  stack.push(t);
  while (stack.length) {
    const c = stack.pop()!;
    size++;
    const x = c % W;
    for (const nb of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
      if (nb < 0 || nb >= N || mass[nb] >= 0 || terrain[nb] <= T_SHALLOW) continue;
      mass[nb] = m;
      stack.push(nb);
    }
  }
  massSize.push(size);
}
let landTotal = 0;
for (const s of massSize) landTotal += s;
// "within reach": half the side of a nation's fair share of the land (at least 80 tiles)
const REACH = Math.max(80, Math.round(Math.sqrt(landTotal / Math.max(1, info.recommendedNations)) / 2));
const coastal = (m: number): boolean => {
  // a landmass touches water that connects to the sea (any water tile next to it)
  for (let t = 0; t < N; t++) {
    if (mass[t] !== m) continue;
    const x = t % W;
    for (const nb of [x > 0 ? t - 1 : -1, x < W - 1 ? t + 1 : -1, t - W, t + W]) if (nb >= 0 && nb < N && terrain[nb] <= T_SHALLOW) return true;
  }
  return false;
};

const spawns = worldMapSpawns(id);
console.log(`${id}: ${W}x${H}, land ${landTotal}, ${massSize.length} landmasses, ${spawns.length} spawns, recommended ${info.recommendedNations} nations`);
const big = massSize.filter((s) => s >= MIN_LANDMASS).length;
console.log(`   landmasses of ${MIN_LANDMASS}+ tiles: ${big}; largest ${Math.max(...massSize)}`);
for (const sp of spawns) {
  const t = sp.tile;
  if (t < 0 || t >= N || terrain[t] <= T_SHALLOW) {
    problem(`spawn ${sp.name} is not on land (tile ${t})`);
    continue;
  }
  if (terrain[t] === T_MOUNTAINS) problem(`spawn ${sp.name} is on mountains`);
  const m = mass[t];
  if (massSize[m] < MIN_LANDMASS) problem(`spawn ${sp.name} is on a landmass of only ${massSize[m]} tiles`);
  // iron and oil within REACH tiles (straight-line), counting any land a nation could reach by land or sea
  const sx = t % W;
  const sy = (t / W) | 0;
  let iron = 0;
  let oil = 0;
  for (let y = Math.max(0, sy - REACH); y <= Math.min(H - 1, sy + REACH); y++) {
    for (let x = Math.max(0, sx - REACH); x <= Math.min(W - 1, sx + REACH); x++) {
      if ((x - sx) * (x - sx) + (y - sy) * (y - sy) > REACH * REACH) continue;
      const r = resource[y * W + x];
      if (r === R_IRON) iron++;
      else if (r === R_OIL) oil++;
    }
  }
  const note = `iron ${iron}, oil ${oil} within ${REACH}`;
  if (!iron || !oil) problem(`spawn ${sp.name}: ${note}`);
  else console.log(`   ${sp.name.padEnd(22)} landmass ${String(massSize[m]).padStart(8)}  ${note}`);
}
// land that is neither big enough nor reachable by sea is dead weight
let unreachable = 0;
for (let m = 0; m < massSize.length; m++) if (massSize[m] >= 50 && !coastal(m)) unreachable += massSize[m];
if (unreachable > landTotal * 0.01) problem(`${unreachable} land tiles sit on landmasses with no coast (unreachable)`);

// play it
const settings: GameSettings = {
  ...cloneSetup(DEFAULT_SETUP),
  seed,
  map: { kind: 'world', id },
  aiCount: nations,
  difficulty: 'normal',
  playerName: 'Nobody',
  playerColor: [255, 255, 255],
  humanPlayer: false,
  timeLimit: 0,
};
const state = createGame(settings, map);
const ticks = minutes * 60 * TICKS_PER_SECOND;
for (let k = 0; k < ticks && state.phase !== 'over'; k++) tick(state);
const nationsAlive = state.players.filter((p) => p && p.id > 0 && !isTribe(p) && p.alive);
const spawned = state.players.filter((p) => p && p.id > 0 && !isTribe(p) && p.spawned);
console.log(`   after ${minutes} min: phase ${state.phase}, nations spawned ${spawned.length}/${nations}, alive ${nationsAlive.length}`);
const tiles = nationsAlive.map((p) => p.tiles).sort((a, b) => b - a);
console.log(`   nation tiles: ${tiles.slice(0, 12).join(' ')}`);
if (spawned.length < nations) problem(`only ${spawned.length} of ${nations} nations spawned`);
const stuck = nationsAlive.filter((p) => p.tiles < 200);
if (stuck.length) problem(`${stuck.length} nations still under 200 tiles after ${minutes} min: ${stuck.map((p) => p.name).join(', ')}`);
console.log(problems.length ? `CHECK ${id} PROBLEMS ${problems.length}` : `CHECK ${id} OK`);
