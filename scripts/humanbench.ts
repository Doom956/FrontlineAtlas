// Human benchmark: how a scripted "average new player" fares against the AI nations at each difficulty.
//
// Player 1 is a bot that plays like a casual new player: it expands into the wilderness and into tribes with 25-35%
// of its troops every few seconds, reacts slowly (decides every 4-6 s), hits back at a nation that attacks it, builds a
// few cities, farms and forts, never uses special abilities (no navy, air, missiles, barrages, paradrops) and never
// makes alliances. Once no wilderness or tribe borders it, it attacks its weakest neighbouring nation (fewest troops
// at home) the same way whenever its troop bar is above 30%. Army mix and research stay on
// auto (the defaults for a human). The rest is the default Classic setup: 8 AI nations, default tribes.
//
// Usage: npx vite-node scripts/humanbench.ts -- [options]
//   --maps medium,world:world    generated sizes (continents type) and/or world:<id>   (default: medium,world:world)
//   --types continents           generated map types, game k uses type k mod the list   (default: continents)
//   --difficulty easy,normal,hard,brutal                                                  (default: all)
//   --seeds 6 --start 1          seeds per map x difficulty                               (default: 6 from 1)
//   --minutes 30                 game-minute cap                                          (default: 30)
//   --jobs 4                     worker processes                                         (default: 4)
//   --style casual               casual (default) or steady: a player who only sends once its troop bar is 45% full
//   --trace                      (with --jobs 1) a line per minute about the bot, and its events
//   --json                       one JSON line per game
//
// Prints per map x difficulty: share of runs the bot is alive (and the game not lost to an AI win) at 10 / 20 min,
// its median land share at 10 / 20 min, its median rank among the nations by land at 20 min, the median minute of
// the first AI nation attack on it, the most AI wars on it at once in the first 10 min, how often and when it died,
// its wins, and how often / when an AI reached the victory share while it was still alive.
import { buildingCost } from '../src/sim/buildings';
import { MIN_ATTACK_TROOPS, TICKS_PER_SECOND, VICTORY_LAND_SHARE } from '../src/sim/config';
import { tick } from '../src/sim/sim';
import { canSpawnAt, createGame, gameSeconds, ownerBox } from '../src/sim/state';
import { borderTiles } from '../src/sim/territory';
import { applyAction } from '../src/sim/actions';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP, SINGLE_PLAYER_NATIONS } from '../src/sim/setup';
import { isTribe, isWater } from '../src/sim/types';
import { loadWorldMap } from '../src/sim/worldmaps';
import type { BuildingType, Difficulty, GameSettings, GameState, MapSize, MapType, Troops } from '../src/sim/types';

declare const process: { argv: string[]; exit(code?: number): never; stdout: { write(s: string): boolean } };

const ME = 1;

// ---------------------------------------------------------------------------------------------------------------
// The bot (only reads the state and acts through applyAction, like a human client)
// ---------------------------------------------------------------------------------------------------------------

/** Own small RNG so the bot never draws from state.rng (the AIs' stream stays as in a real game). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUILD_PLAN: BuildingType[] = ['farm', 'city', 'farm', 'fort', 'city', 'farm', 'city', 'fort'];
/** --style steady: the troop-bar fill below which the bot doesn't send (growth peaks at about 42%). */
const STEADY_FILL = 0.45;
/** Seconds between two builds (a new player builds now and then, not constantly). */
const BUILD_PAUSE = 50;

class NewPlayerBot {
  private rnd: () => number;
  private nextTick = 0;
  private nextBuildTick = 0;
  private planned = 0;
  /** 'steady': waits until its troop bar is at least STEADY_FILL full before every send (a player who learned to). */
  constructor(seed: number, private style: 'casual' | 'steady' = 'casual') {
    this.rnd = mulberry(seed * 7919 + 13);
  }

  /** Spawn: the best of a few random valid spots by nearby land (a quick look at the map). */
  spawn(state: GameState): void {
    const map = state.map;
    const w = map.width;
    const n = w * map.height;
    let best = -1;
    let bestScore = -1;
    for (let k = 0, valid = 0; k < 4000 && valid < 6; k++) {
      const t = Math.floor(this.rnd() * n);
      if (isWater(map.terrain[t]) || !canSpawnAt(state, ME, t)) continue;
      valid++;
      let land = 0;
      const x0 = t % w;
      const y0 = (t / w) | 0;
      for (let dy = -30; dy <= 30; dy += 6) {
        for (let dx = -30; dx <= 30; dx += 6) {
          const x = x0 + dx;
          const y = y0 + dy;
          if (x >= 0 && y >= 0 && x < w && y < map.height && !isWater(map.terrain[y * w + x])) land++;
        }
      }
      if (land > bestScore) {
        bestScore = land;
        best = t;
      }
    }
    if (best >= 0) applyAction(state, ME, { type: 'spawn', tile: best });
  }

  /** One look at the screen: called every tick, acts every 4-6 s. */
  update(state: GameState): void {
    if (state.phase !== 'playing' || state.tick < this.nextTick) return;
    this.nextTick = state.tick + Math.round((4 + 2 * this.rnd()) * TICKS_PER_SECOND);
    const p = state.players[ME];
    if (!p.alive) return;
    const map = state.map;
    const w = map.width;
    // What borders us: one tile per neighbour (a stride over long borders).
    const tileOf = new Map<number, number>();
    const { list, len } = borderTiles(state, ME);
    const step = Math.max(1, Math.floor(len / 1500));
    for (let k = 0; k < len; k += step) {
      const t = list[k];
      const x = t % w;
      for (const j of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, t - w, t + w]) {
        if (j < 0 || j >= map.owner.length || isWater(map.terrain[j])) continue;
        const o = map.owner[j];
        if (o !== ME && !tileOf.has(o)) tileOf.set(o, j);
      }
    }
    const home = p.troops.infantry + p.troops.armor + p.troops.artillery;
    const send = (target: number, share: number): void => {
      const tile = tileOf.get(target);
      if (tile === undefined) return;
      const f = Math.min(1, share);
      const troops: Troops = { infantry: p.troops.infantry * f, armor: p.troops.armor * f, artillery: p.troops.artillery * f };
      if (home * f < MIN_ATTACK_TROOPS) return;
      applyAction(state, ME, { type: 'attack', tile, troops });
    };
    const share = 0.25 + 0.1 * this.rnd();
    if (this.style === 'steady' && p.maxPop > 0 && home < p.maxPop * STEADY_FILL) {
      this.build(state, tileOf);
      return;
    }
    // Hit back at whoever attacks us (the biggest attacker we border).
    let attacker = 0;
    let most = 0;
    for (const a of state.attacks) {
      if (a.target !== ME || !tileOf.has(a.attacker)) continue;
      const t = a.troops.infantry + a.troops.armor + a.troops.artillery;
      if (t > most) {
        most = t;
        attacker = a.attacker;
      }
    }
    if (attacker) send(attacker, share);
    else {
      const tribes = [...tileOf.keys()].filter((o) => o !== 0 && isTribe(state.players[o]));
      const nations = [...tileOf.keys()].filter((o) => o !== 0 && !isTribe(state.players[o]));
      if (tileOf.has(0) && (!tribes.length || this.rnd() < 0.65)) send(0, share);
      else if (tribes.length) send(tribes[Math.floor(this.rnd() * tribes.length)], share);
      else if (nations.length && p.maxPop > 0 && home > p.maxPop * 0.3) {
        // Boxed in: keeps clicking on the weakest neighbour while the troop bar is not low.
        let weakest = nations[0];
        for (const q of nations) {
          const tq = state.players[q].troops;
          const tw = state.players[weakest].troops;
          if (tq.infantry + tq.armor + tq.artillery < tw.infantry + tw.armor + tw.artillery) weakest = q;
        }
        send(weakest, share);
      }
    }
    this.build(state, tileOf);
  }

  private build(state: GameState, tileOf: Map<number, number>): void {
    if (state.tick < this.nextBuildTick || this.planned >= BUILD_PLAN.length) return;
    const type = BUILD_PLAN[this.planned];
    const p = state.players[ME];
    const cost = buildingCost(state, ME, type);
    if (p.gold < cost.gold || p.iron < cost.iron) return;
    const map = state.map;
    const w = map.width;
    // A fort near a nation we border; anything else somewhere in our land.
    let near = -1;
    if (type === 'fort') {
      for (const [o, t] of tileOf) if (o !== 0 && !isTribe(state.players[o])) near = t;
      if (near < 0) {
        this.planned++; // nobody to fear yet: skip it
        return;
      }
    }
    const box = ownerBox(state, ME);
    if (!box) return;
    const [x0, y0, x1, y1] = box;
    for (let k = 0; k < 60; k++) {
      let t: number;
      if (near >= 0) {
        const x = (near % w) + Math.round((this.rnd() - 0.5) * 30);
        const y = ((near / w) | 0) + Math.round((this.rnd() - 0.5) * 30);
        if (x < 0 || y < 0 || x >= w || y >= map.height) continue;
        t = y * w + x;
      } else {
        t = (y0 + Math.floor(this.rnd() * (y1 - y0 + 1))) * w + x0 + Math.floor(this.rnd() * (x1 - x0 + 1));
      }
      if (map.owner[t] !== ME) continue;
      if (applyAction(state, ME, { type: 'build', building: type, tile: t }).ok) {
        this.planned++;
        this.nextBuildTick = state.tick + BUILD_PAUSE * TICKS_PER_SECOND;
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------------------------------------------

interface Job {
  index: number;
  /** generated size, or world:<id> */
  map: string;
  type: MapType;
  difficulty: Difficulty;
  seed: number;
}

interface Result {
  job: Job;
  /** alive and no AI win yet at 10 / 20 min */
  alive10: boolean;
  alive20: boolean;
  share10: number;
  share20: number;
  /** rank among the alive nations by land at 20 min (1 = biggest; nations + 1 if dead) */
  rank20: number;
  /** game seconds of the first AI nation attack on the bot (-1 none) */
  firstAttack: number;
  /** most AI nations attacking it at once in the first 10 min */
  maxWars10: number;
  /** distinct AI nations that attacked it in the first 10 min */
  attackers10: number;
  /** minute it died (-1 alive at the end) */
  deathMinute: number;
  winner: number;
  winMinute: number;
  minutes: number;
}

/** --trace: one line per game minute about the bot and the biggest AI. */
let TRACE = false;
/** --style casual (default) | steady */
let STYLE: 'casual' | 'steady' = 'casual';

async function runGame(job: Job, minutes: number): Promise<Result> {
  const world = job.map.startsWith('world:') ? job.map.slice(6) : null;
  const settings: GameSettings = {
    ...cloneSetup(DEFAULT_SETUP),
    seed: job.seed,
    map: world ? { kind: 'world', id: world } : { kind: 'generated', type: job.type, size: job.map as MapSize },
    aiCount: SINGLE_PLAYER_NATIONS,
    difficulty: job.difficulty,
    playerName: 'Bench',
    playerColor: [255, 255, 255],
    humanPlayer: true,
    timeLimit: 0,
    victoryLandShare: VICTORY_LAND_SHARE,
    tribeCount: -1,
    modifiers: { ...DEFAULT_MODIFIERS },
  };
  const state = createGame(settings, world ? await loadWorldMap(world) : null);
  const bot = new NewPlayerBot(job.seed, STYLE);
  // A new player looks around for a few seconds before clicking a start.
  while (state.phase === 'spawn') {
    if (state.tick >= 30 && !state.players[ME].spawned) bot.spawn(state);
    tick(state);
    state.events.length = 0;
  }
  const r: Result = {
    job,
    alive10: false,
    alive20: false,
    share10: 0,
    share20: 0,
    rank20: 0,
    firstAttack: -1,
    maxWars10: 0,
    attackers10: 0,
    deathMinute: -1,
    winner: 0,
    winMinute: -1,
    minutes: 0,
  };
  const seen10 = new Set<number>();
  const land = state.map.landTileCount;
  const nations = state.players.filter((p) => p.id !== 0 && !isTribe(p));
  const cap = minutes * 60 * TICKS_PER_SECOND + state.tick;
  let next10 = true;
  let next20 = true;
  while (state.phase === 'playing' && state.tick < cap) {
    bot.update(state);
    tick(state);
    if (TRACE) for (const e of state.events) if (e.players.includes(ME) && e.kind !== 'buildingDone' && e.kind !== 'researchDone') console.log(`    ${f1(gameSeconds(state) / 60)}m ${e.kind}: ${e.message}`);
    state.events.length = 0;
    const s = gameSeconds(state);
    if (state.tick % 5 === 0) {
      let wars = 0;
      for (const a of state.attacks) {
        if (a.target !== ME || isTribe(state.players[a.attacker])) continue;
        if (r.firstAttack < 0) r.firstAttack = s;
        if (s <= 600) {
          wars++;
          seen10.add(a.attacker);
        }
      }
      r.maxWars10 = Math.max(r.maxWars10, wars);
    }
    const me = state.players[ME];
    if (TRACE && state.tick % (60 * TICKS_PER_SECOND) === 0) {
      const tot = (t: Troops): number => Math.round(t.infantry + t.armor + t.artillery);
      let big = nations[0];
      for (const q of nations) if (q.id !== ME && q.alive && (big.id === ME || q.tiles > big.tiles)) big = q;
      const mine = state.attacks.filter((a) => a.attacker === ME && a.target !== 0).map((a) => `${a.target}:${tot(a.troops)}/${a.tilesTaken}t`);
      if (mine.length) console.log(`    bot attacks ${mine.join(' ')}`);
      const atk = state.attacks.filter((a) => a.target === ME && !isTribe(state.players[a.attacker])).map((a) => `${a.attacker}:${tot(a.troops)}`);
      console.log(`  ${f1(s / 60)}m bot ${pct(me.tiles / land)} troops ${tot(me.troops)}/${Math.round(me.maxPop)} gold ${Math.round(me.gold)} | top AI ${big.id} ${pct(big.tiles / land)} troops ${tot(big.troops)}/${Math.round(big.maxPop)} | attacks on bot ${atk.join(' ') || '-'} | AIs ${nations.filter((q) => q.id !== ME && q.alive).map((q) => Math.round((q.tiles / land) * 100)).sort((a, b) => b - a).join(',')}`);
    }
    if (!me.alive && r.deathMinute < 0) r.deathMinute = s / 60;
    if (next10 && s >= 600) {
      next10 = false;
      r.alive10 = me.alive;
      r.share10 = me.tiles / land;
    }
    if (next20 && s >= 1200) {
      next20 = false;
      r.alive20 = me.alive;
      r.share20 = me.tiles / land;
      r.rank20 = me.alive ? 1 + nations.filter((q) => q.id !== ME && q.alive && q.tiles > me.tiles).length : nations.length + 1;
    }
  }
  const s = gameSeconds(state);
  r.minutes = s / 60;
  r.attackers10 = seen10.size;
  if (state.phase === 'over') {
    r.winner = state.winner;
    if (state.winner && state.players[ME].alive) r.winMinute = s / 60;
    else if (state.winner) r.winMinute = s / 60;
    // A game that ended before 10 / 20 min: alive only if the bot won.
    const won = state.winner === ME;
    if (next10) {
      r.alive10 = won;
      r.share10 = state.players[ME].tiles / land;
    }
    if (next20) {
      r.alive20 = won;
      r.share20 = state.players[ME].tiles / land;
      r.rank20 = won ? 1 : nations.length + 1;
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Options, sharding, report
// ---------------------------------------------------------------------------------------------------------------

interface Options {
  maps: string[];
  types: MapType[];
  difficulties: Difficulty[];
  seeds: number;
  start: number;
  minutes: number;
  jobs: number;
  json: boolean;
  shard: number;
  of: number;
}

function parseOptions(argv: string[]): Options {
  const args = argv.filter((a) => a !== '--');
  const o: Options = {
    maps: ['medium', 'world:world'],
    types: ['continents'],
    difficulties: ['easy', 'normal', 'hard', 'brutal'],
    seeds: 6,
    start: 1,
    minutes: 30,
    jobs: 4,
    json: false,
    shard: -1,
    of: 1,
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const v = args[k + 1] ?? '';
    const list = (): string[] => v.split(',').filter(Boolean);
    switch (a) {
      case '--maps': o.maps = list(); k++; break;
      case '--types': o.types = list() as MapType[]; k++; break;
      case '--difficulty': o.difficulties = list() as Difficulty[]; k++; break;
      case '--seeds': o.seeds = Number(v); k++; break;
      case '--start': o.start = Number(v); k++; break;
      case '--minutes': o.minutes = Number(v); k++; break;
      case '--jobs': o.jobs = Math.max(1, Number(v) || 1); k++; break;
      case '--json': o.json = true; break;
      case '--trace': TRACE = true; break;
      case '--style': STYLE = v === 'steady' ? 'steady' : 'casual'; k++; break;
      case '--shard': {
        const [s, of] = v.split('/').map(Number);
        o.shard = s;
        o.of = of;
        k++;
        break;
      }
      default:
        console.error(`Unknown option ${a}`);
        process.exit(1);
    }
  }
  return o;
}

function jobList(o: Options): Job[] {
  const jobs: Job[] = [];
  for (const map of o.maps) {
    for (const difficulty of o.difficulties) {
      for (let k = 0; k < o.seeds; k++) jobs.push({ index: jobs.length, map, type: o.types[k % o.types.length], difficulty, seed: o.start + k });
    }
  }
  return jobs;
}

const median = (v: number[]): number => {
  if (!v.length) return NaN;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '-');

function report(rs: Result[], o: Options): void {
  const head = ['map', 'diff', 'runs', 'alive10', 'alive20', 'land10', 'land20', 'rank20', '1st atk', 'wars10', 'atkrs10', 'died', 'death min', 'wins', 'AI won', 'AI win min'];
  const rows: string[][] = [head];
  for (const map of o.maps) {
    for (const d of o.difficulties) {
      const g = rs.filter((r) => r.job.map === map && r.job.difficulty === d);
      if (!g.length) continue;
      const firsts = g.filter((r) => r.firstAttack >= 0).map((r) => r.firstAttack / 60);
      // An AI reaching the victory share while the bot is alive (a game ended by the bot's death is not counted here).
      const aiWins = g.filter((r) => r.winner && r.winner !== ME && r.deathMinute < 0);
      const deaths = g.filter((r) => r.deathMinute >= 0);
      rows.push([
        map,
        d,
        String(g.length),
        pct(g.filter((r) => r.alive10).length / g.length),
        pct(g.filter((r) => r.alive20).length / g.length),
        pct(median(g.map((r) => r.share10))),
        pct(median(g.map((r) => r.share20))),
        f1(median(g.map((r) => r.rank20))),
        firsts.length ? `${f1(median(firsts))}m` : 'never',
        String(Math.max(...g.map((r) => r.maxWars10))),
        f1(median(g.map((r) => r.attackers10))),
        `${deaths.length}/${g.length}`,
        f1(median(deaths.map((r) => r.deathMinute))),
        `${g.filter((r) => r.winner === ME).length}/${g.length}`,
        `${aiWins.length}/${g.length}`,
        f1(median(aiWins.map((r) => r.winMinute))),
      ]);
    }
  }
  const widths = head.map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const r of rows) console.log(r.map((v, c) => (c < 2 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join('  '));
  console.log(`(alive = alive with no AI win yet; land = median share of all land; rank among ${SINGLE_PLAYER_NATIONS + 1} nations by land, dead = last; 1st atk = median minute of the first AI nation attack; wars10 = most AI nations attacking at once in the first 10 min (worst run); atkrs10 = median distinct AI attackers in the first 10 min; died = bot eliminated before the cap, death min = median minute; AI won = an AI reached the victory share while the bot lived; cap ${o.minutes} min)`);
}

async function runShards(o: Options, argv: string[]): Promise<Result[]> {
  const cp = (await import('node:child_process')) as unknown as {
    spawn(cmd: string, args: string[], opts: object): {
      stdout: { on(ev: 'data', f: (b: unknown) => void): void };
      stderr: { on(ev: 'data', f: (b: unknown) => void): void };
      on(ev: 'close', f: (code: number) => void): void;
    };
  };
  const rest = argv.filter((a) => a !== '--');
  const out: Result[] = [];
  await Promise.all(
    Array.from({ length: o.jobs }, (_, s) =>
      new Promise<void>((resolve, reject) => {
        const child = cp.spawn('node_modules/.bin/vite-node', ['scripts/humanbench.ts', '--', ...rest, '--shard', `${s}/${o.jobs}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        child.stdout.on('data', (b) => {
          buf += String(b);
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.startsWith('{')) continue;
            const r = JSON.parse(line) as Result;
            out.push(r);
            if (o.json) console.log('JSON ' + line);
          }
        });
        child.stderr.on('data', (b) => process.stdout.write(String(b)));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${s} exited with ${code}`))));
      }),
    ),
  );
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const o = parseOptions(argv);
  const jobs = jobList(o);
  if (o.shard >= 0) {
    for (const j of jobs) if (j.index % o.of === o.shard) process.stdout.write(JSON.stringify(await runGame(j, o.minutes)) + '\n');
    return;
  }
  console.log(`Borderfall human bench: ${jobs.length} games (${o.maps.join(',')} x ${o.difficulties.join(',')} x ${o.seeds} seeds from ${o.start}), cap ${o.minutes} min, ${o.jobs} job(s).`);
  const t0 = performance.now();
  let rs: Result[];
  if (o.jobs <= 1) {
    rs = [];
    for (const j of jobs) {
      const r = await runGame(j, o.minutes);
      rs.push(r);
      if (o.json) console.log('JSON ' + JSON.stringify(r));
    }
  } else rs = await runShards(o, argv);
  report(rs, o);
  console.log(`Done in ${Math.round((performance.now() - t0) / 1000)} s.`);
}

void main();
