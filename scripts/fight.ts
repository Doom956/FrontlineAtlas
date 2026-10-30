// Controlled fight: a small nation against an AI nation 5x bigger (land and army) on open plains, nobody else around.
//
// Usage: npx vite-node scripts/fight.ts -- [--ratio 5] [--seeds 6] [--respond] [--minutes 6] [--trace]
//
// Map 120 x 80 plains, no wilderness: the small nation holds a 40 x 40 block (1600 tiles, capital in the middle) on
// the west edge, the big one (an AI warlord, difficulty hard: no human protections) holds the rest (8000 tiles, 5x).
// Armies start at half the small nation's troop cap and `ratio` x that. The big AI plays normally (its own war
// logic, army mix, research, buildings). The small nation is a passive human by default; with --respond it hits
// back like an AI defender would (60% of its home army at the attacker every 5 s while attacked).
// Prints per seed and as medians: seconds until the small nation lost half its land, until its capital fell, until
// it was eliminated, and its land left at the cap.
import { tick } from '../src/sim/sim';
import { applyAction } from '../src/sim/actions';
import type { GameState } from '../src/sim/types';
import { claimRect, makeFlatGame, troopSum } from '../tests/helpers';

declare const process: { argv: string[] };

const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (name: string, dflt: number): number => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const RATIO = opt('--ratio', 5);
const SEEDS = opt('--seeds', 6);
const MINUTES = opt('--minutes', 6);
const RESPOND = args.includes('--respond');
const TRACE = args.includes('--trace');
const W = 120;
const H = 80;
const SMALL = 1;
const BIG = 2;

interface Result {
  first: number;
  half: number;
  capital: number;
  dead: number;
  smallLeft: number;
}

function run(seed: number): Result {
  const s: GameState = makeFlatGame(W, H, 2, { seed, human: true });
  s.settings.difficulty = 'hard';
  s.settings.victoryLandShare = 1; // the big one holds 83% of the land: no victory
  s.players[BIG].personality = 'warlord';
  // Past the early-game grace.
  s.tick = 12 * 60 * 10;
  s.playStartTick = 0;
  claimRect(s, SMALL, 0, 20, 39, 59);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (s.map.owner[y * W + x] === 0) claimRect(s, BIG, x, y, x, y);
  const cap = 40 * W + 20;
  s.players[SMALL].capital = cap;
  (s.players[SMALL] as { heartTile?: number }).heartTile = cap;
  s.players[BIG].capital = 40 * W + 80;
  (s.players[BIG] as { heartTile?: number }).heartTile = s.players[BIG].capital;
  tick(s); // troop caps
  const smallTroops = Math.max(20000, s.players[SMALL].maxPop * 0.5);
  s.players[SMALL].troops = { infantry: smallTroops, armor: 0, artillery: 0 };
  s.players[BIG].troops = { infantry: smallTroops * RATIO, armor: 0, artillery: 0 };
  const start = s.tick;
  const startTiles = s.players[SMALL].tiles;
  const r: Result = { first: -1, half: -1, capital: -1, dead: -1, smallLeft: 0 };
  let nextSmall = 0;
  const bigFront = 40 * W + 40;
  for (let k = 0; k < MINUTES * 600; k++) {
    const small = s.players[SMALL];
    if (!small.alive) break;
    const t = s.tick - start;
    const incoming = s.attacks.find((a) => a.attacker === BIG && a.target === SMALL);
    if (incoming && r.first < 0) r.first = t / 10;
    if (RESPOND && t >= nextSmall && incoming) {
      let pick = s.map.owner[bigFront] === BIG ? bigFront : -1;
      if (pick < 0) for (let i = 0; i < s.map.owner.length; i++) if (s.map.owner[i] === BIG) { pick = i; break; }
      if (pick >= 0) applyAction(s, SMALL, { type: 'attack', tile: pick, troops: { infantry: troopSum(small.troops) * 0.6, armor: 0, artillery: 0 } });
      nextSmall = t + 50;
    }
    tick(s);
    const sec = (s.tick - start) / 10;
    if (TRACE && (s.tick - start) % 100 === 0) {
      const big = s.players[BIG];
      const att = s.attacks.filter((a) => a.attacker === BIG).reduce((x, a) => x + troopSum(a.troops), 0);
      console.log(`  t=${sec}s small ${s.players[SMALL].tiles} tiles ${Math.round(troopSum(s.players[SMALL].troops))} troops; big home ${Math.round(troopSum(big.troops))} in attacks ${Math.round(att)}`);
    }
    if (r.half < 0 && s.players[SMALL].tiles <= startTiles / 2) r.half = sec;
    if (r.capital < 0 && s.map.owner[cap] !== SMALL) r.capital = sec;
    if (r.dead < 0 && !s.players[SMALL].alive) r.dead = sec;
  }
  r.smallLeft = s.players[SMALL].alive ? s.players[SMALL].tiles / startTiles : 0;
  return r;
}

const med = (xs: number[]): number => {
  const v = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  if (!v.length) return -1;
  return v[Math.floor(v.length / 2)];
};
const fmt = (x: number): string => (x < 0 ? `>${MINUTES * 60}` : x.toFixed(0));
const rows: Result[] = [];
console.log(`Fight: small (1600 tiles) vs an AI 5x its land with ${RATIO}x its army, ${RESPOND ? 'small hits back' : 'small passive'}, ${MINUTES} min cap`);
console.log('seed   1st atk  half(s)  capital(s)  dead(s)  land left');
for (let seed = 1; seed <= SEEDS; seed++) {
  const r = run(seed);
  rows.push(r);
  console.log(`${String(seed).padEnd(6)} ${fmt(r.first).padStart(7)} ${fmt(r.half).padStart(8)} ${fmt(r.capital).padStart(11)} ${fmt(r.dead).padStart(8)} ${(r.smallLeft * 100).toFixed(0).padStart(9)}%`);
}
const cnt = (f: (r: Result) => number): string => `${rows.filter((r) => f(r) >= 0).length}/${rows.length}`;
console.log(
  `median ${fmt(med(rows.map((r) => r.first))).padStart(7)} ${fmt(med(rows.map((r) => r.half))).padStart(8)} ${fmt(med(rows.map((r) => r.capital))).padStart(11)} ${fmt(med(rows.map((r) => r.dead))).padStart(8)}   (fell: half ${cnt((r) => r.half)}, capital ${cnt((r) => r.capital)}, dead ${cnt((r) => r.dead)}; medians over the runs where it happened)`,
);
