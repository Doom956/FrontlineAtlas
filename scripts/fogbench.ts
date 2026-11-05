// Fog of war cost on the biggest setup: a huge generated map, 40 AI nations, default tribes, one human seat.
//
//   npx vite-node scripts/fogbench.ts [ticks]
//
// Plays the spawn phase and `ticks` game ticks (default 3000 = 5 minutes), then reports the vision refresh (one full
// pass for every player, as at the start of play, and the staggered per-tick cost the sim pays every tick) and the
// extra hash cost (hashState with and without the fog bits). Numbers are ms on this machine (Node).
import { updateFog } from '../src/sim/fog';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import { cloneSetup, DEFAULT_SETUP } from '../src/sim/setup';
import type { GameSettings } from '../src/sim/types';

const ticks = Number(process.argv[2] ?? 3000);
const settings: GameSettings = {
  ...cloneSetup(DEFAULT_SETUP),
  seed: 3,
  map: { kind: 'generated', type: 'continents', size: 'huge' },
  aiCount: 40,
  tribeCount: -1,
  playerName: 'Bench',
  playerColor: [255, 255, 255],
  humanPlayer: true,
};
settings.modifiers = { ...settings.modifiers, fogOfWar: true };

const t0 = performance.now();
const s = createGame(settings);
const nations = s.players.filter((p) => p.id > 0 && p.personality !== 'tribe').length;
console.log(`map ${s.map.width} x ${s.map.height}, ${nations} nations with vision, ${s.players.length - 1 - nations} tribes, ${s.fog!.words} words per bitset (${(performance.now() - t0).toFixed(0)} ms to create)`);
while (s.phase === 'spawn') tick(s);
for (let k = 0; k < ticks; k++) tick(s);

const time = (n: number, f: (k: number) => void): number => {
  for (let k = 0; k < Math.min(5, n); k++) f(k); // warm up
  const a = performance.now();
  for (let k = 0; k < n; k++) f(k);
  return (performance.now() - a) / n;
};
const full = time(20, () => updateFog(s, true));
const base = s.tick;
const stagger = time(200, (k) => {
  s.tick = base + k;
  updateFog(s);
});
s.tick = base;
const hash = time(30, () => hashState(s));
const fog = s.fog;
s.fog = undefined;
const hashOff = time(30, () => hashState(s));
s.fog = fog;
console.log(`full vision pass, every player: ${full.toFixed(2)} ms (once, when play starts)`);
console.log(`staggered refresh per tick:     ${stagger.toFixed(3)} ms`);
console.log(`hashState with fog / without:   ${hash.toFixed(2)} / ${hashOff.toFixed(2)} ms (online: every 10 turns)`);
