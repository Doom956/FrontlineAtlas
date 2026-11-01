// temporary probe (not committed): per-nation bomber sorties over time for one batch game
import { TICKS_PER_SECOND, VICTORY_LAND_SHARE } from '../src/sim/config';
import { tick } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP } from '../src/sim/setup';
import { isTribe } from '../src/sim/types';
import { buildingsOf } from '../src/sim/buildings';
import { airWingSize } from '../src/sim/airwings';
declare const process: { argv: string[] };
const a = process.argv.slice(2).filter((x) => x !== '--');
const seed = Number(a[0] ?? 40), type = (a[1] ?? 'highlands') as any, mins = Number(a[2] ?? 45);
const state = createGame({ ...cloneSetup(DEFAULT_SETUP), seed, map: { kind: 'generated', type, size: 'medium' }, aiCount: 8, difficulty: 'normal', playerName: 'Nobody', playerColor: [255, 255, 255], humanPlayer: false, timeLimit: 0, victoryLandShare: VICTORY_LAND_SHARE, tribeCount: -1, modifiers: { ...DEFAULT_MODIFIERS } } as any, null);
console.log('cfg', seed, type, mins, state.map.width, state.map.height, state.players.length);
while (state.phase === 'spawn') { tick(state); state.events.length = 0; }
const seen = new Set<number>();
const per: Record<number, number[]> = {};
let maxAir: Record<number, number> = {};
for (let t = 0; t < mins * 60 * TICKS_PER_SECOND && state.phase === 'playing'; t++) {
  tick(state); state.events.length = 0;
  const fly: Record<number, number> = {};
  for (const u of state.units) if (u.type === 'bomber' && u.hp > 0) {
    fly[u.owner] = (fly[u.owner] ?? 0) + 1;
    if (!seen.has(u.id)) { seen.add(u.id); const m = Math.floor(t / (300 * TICKS_PER_SECOND)); (per[u.owner] ??= Array(10).fill(0))[m] += u.variant === 'heavyBomber' ? 1 : 0; }
  }
  for (const k in fly) maxAir[k] = Math.max(maxAir[k] ?? 0, fly[k]);
  if (t % (300 * TICKS_PER_SECOND) === 0 || t === mins * 600 - 1) {
    const s = state.players.filter((p) => p.id > 0 && !isTribe(p) && p.alive).map((p) => { const afs = buildingsOf(state, p.id, 'airfield'); return `${p.id}:${p.personality?.slice(0,3)} ${p.doctrine.id ?? '-'} t${p.tiles} af${afs.map((b) => b.level + '/' + b.bombers + 'w' + airWingSize(state, b)).join(',')}`; });
    console.log(`min ${(t / 600).toFixed(0)}: ${s.join(' | ')}`);
  }
}
console.log('end', (state.tick / 600).toFixed(1), 'winner', state.winner);
for (const k in per) console.log(`nation ${k}: heavy per 5 min ${per[k].join(' ')} total ${per[k].reduce((x, y) => x + y, 0)} maxAirborne ${maxAir[k]}`);
