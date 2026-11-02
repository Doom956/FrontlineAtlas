import { tick } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP } from '../src/sim/setup';
import { VICTORY_LAND_SHARE } from '../src/sim/config';
import { setTrenchesOffByDefault } from '../src/sim/trenches';
const off = process.argv.includes('off');
setTrenchesOffByDefault(off);
for (const [map, seed] of [['continents', 14001], ['pangaea', 14003], ['highlands', 14004]] as const) {
  const s = createGame({ ...cloneSetup(DEFAULT_SETUP), seed, map: { kind: 'generated', type: map, size: 'medium' }, aiCount: 8, difficulty: 'normal', playerName: 'N', playerColor: [255, 255, 255], humanPlayer: false, timeLimit: 0, victoryLandShare: VICTORY_LAND_SHARE, tribeCount: undefined as any, modifiers: { ...DEFAULT_MODIFIERS } } as any, null);
  while (s.phase === 'spawn') { tick(s); s.events.length = 0; }
  const g = globalThis as any; g.__tr = 0;
  const tr: number[] = []; const air: number[] = []; const tot: number[] = [];
  for (let k = 0; k < 25 * 60 * 10 && s.phase === 'playing'; k++) {
    const t0 = performance.now(); tick(s); tot.push(performance.now() - t0); tr.push(g.__trLast ?? 0); air.push(g.__air ?? 0); s.events.length = 0;
  }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))].toFixed(2);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  console.log("parts band/decay/dig/flatten ms, band tiles", (globalThis as any).__p?.map((x: number) => x.toFixed(0))); (globalThis as any).__p = [0,0,0,0,0];
  console.log(`${map} ${seed} off=${off} ticks ${tot.length} tick p50/p99 ${q(tot, 0.5)}/${q(tot, 0.99)} | trench share ${(100 * sum(tr) / sum(tot)).toFixed(1)}% p99 ${q(tr, 0.99)} max ${Math.max(...tr).toFixed(2)} | air share ${(100 * sum(air) / sum(tot)).toFixed(1)}% p99 ${q(air, 0.99)}`);
}
