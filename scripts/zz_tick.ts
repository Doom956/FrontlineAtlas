import { cloneSetup, DEFAULT_SETUP } from '../src/sim/setup';
import { VICTORY_LAND_SHARE } from '../src/sim/config';
import { tick } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import type { MapSize, MapType } from '../src/sim/types';
declare const process: { argv: string[] };
const a = process.argv.slice(2).filter((x) => x !== '--');
const [seed, minutes, size, type, ais] = [Number(a[0]), Number(a[1]), a[2] as MapSize, a[3] as MapType, Number(a[4])];
const state = createGame({ ...cloneSetup(DEFAULT_SETUP), seed, map: { kind: 'generated', type, size }, aiCount: ais, difficulty: 'normal', playerName: 'Nobody', playerColor: [255, 255, 255], humanPlayer: false, timeLimit: 0, victoryLandShare: VICTORY_LAND_SHARE });
while (state.phase === 'spawn') tick(state);
const per: number[] = [];
let shipMax = 0, stationMax = 0, divMax = 0, headMax = 0, spearheads = 0;
for (let k = 0; k < minutes * 600 && state.phase === 'playing'; k++) {
  const t = performance.now();
  tick(state);
  per.push(performance.now() - t);
  for (const e of state.events) if (e.kind === 'spearheadStarted') spearheads++;
  state.events.length = 0;
  if (k % 300 === 299) {
    const ws = state.units.filter((u) => u.type === 'warship' && u.hp > 0);
    const dv = state.units.filter((u) => u.type === 'tankDivision' && u.hp > 0);
    shipMax = Math.max(shipMax, ws.length); stationMax = Math.max(stationMax, ws.filter((u) => u.state === 3).length);
    divMax = Math.max(divMax, dv.length); headMax = Math.max(headMax, dv.filter((u) => u.state === 3).length);
    if (k % 3000 === 2999) console.log(`min ${((k + 1) / 600).toFixed(0)}: warships ${ws.length} station ${ws.filter((u) => u.state === 3).length} chase ${ws.filter((u) => u.state === 2).length} divisions ${dv.length} support ${dv.filter((u) => u.mode === 'support').length} spearheading ${dv.filter((u) => u.state === 3).length}`);
  }
}
per.sort((x, y) => x - y);
const p = (q: number) => per[Math.min(per.length - 1, Math.floor(per.length * q))].toFixed(2);
console.log(`${size} ${type} ${ais} AIs ${per.length} ticks: p50 ${p(0.5)} p95 ${p(0.95)} p99 ${p(0.99)} max ${per[per.length - 1].toFixed(1)}; max warships ${shipMax} on station ${stationMax}, max divisions ${divMax} spearheading ${headMax}, spearheads started ${spearheads}, phase ${state.phase}`);
