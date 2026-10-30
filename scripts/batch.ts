// Balance batch runner: many AI-only games per configuration, aggregated into balance and performance tables.
//
// Usage: npx vite-node scripts/batch.ts -- [options]     (spawns workers with node_modules/.bin/vite-node)
//   --sizes small,medium,large   map sizes (small, medium, large, huge) or real-world maps as world:<id>
//                                (e.g. world:world,world:europe)   (default: small,medium,large)
//   --ais default                AI nation counts, or 'default' = config DEFAULT_AI_COUNT per size (default)
//   --maps continents,archipelago,pangaea,highlands
//                                map types; game k of a configuration uses map k mod the list (default: all four)
//   --seeds 4                    games per size x AI count      (default: 4)
//   --start 1                    first seed                     (default: 1)
//   --minutes 55                 game-minute cap per game       (default: 55)
//   --tribes -1                  tribes per game, < 0 = the default for the map's land (setup.defaultTribeCount)
//   --mods fastGame,peaceMinutes=4,goldMultiplier=2
//                                game modifiers (types.Modifiers; a bare name = true)
//   --difficulty normal          easy | normal | hard | brutal
//   --jobs 4                     parallel worker processes (1 = in this process; use 1 for tick timings)
//   --json                       also print one JSON line per game
//   --doctrines ai               ai = the AIs choose (default); random = every nation gets a random doctrine at the
//                                unlock (a fair test of each doctrine's strength: no personality bias); off = no
//                                doctrine bonus ever applies (baseline)
//
// What it prints, per configuration and over all games: share of games with a winner and the median minute of the
// win, army mix (armor / artillery share of all nations' armies) at 10/20/30 min, the troop mixes winners used,
// building counts per type, techs at 20 min, how often the leader at 8 / 15 min wins (snowball), atom bombs, naval
// invasions, air raids, eliminations over time, how often nations sit idle with a full troop bar, the biggest
// army, and ms/tick (p50 / p95 / p99; use --jobs 1 for clean timings). Also: building sites and levels at the end,
// paradrops (shot down / landed), artillery barrages (forts and SAMs silenced), air and missile interceptions, and
// whether the winners used the special abilities more than the average nation. Doctrines: which doctrine each nation
// held longest (by personality), switches, and the win rate per doctrine against its pick share (the winner, or the
// land leader among nations when the game hits the minute cap; ratios over 1.5 are flagged).
import { BUILDING_ORDER, DEFAULT_AI_COUNT, TICKS_PER_SECOND, VICTORY_LAND_SHARE, WATCHTOWER_DEF_RADIUS } from '../src/sim/config';
import { armyTotal, population } from '../src/sim/economy';
import { fortMultiplierAt, fortRadius } from '../src/sim/buildings';
import { forEachInRadius } from '../src/sim/grid';
import { tick } from '../src/sim/sim';
import { applyAction } from '../src/sim/actions';
import { doctrineUnlockTick } from '../src/sim/doctrines';
import { runawayLeader } from '../src/sim/allies';
import { createGame, gameSeconds } from '../src/sim/state';
import { DOCTRINE_IDS, isTribe } from '../src/sim/types';
import { aiSpendStats } from '../src/sim/aispending';
import type { AISpendStats } from '../src/sim/aispending';
import { exclusiveGroups, groupMembers } from '../src/sim/techtree';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP, SINGLE_PLAYER_NATIONS } from '../src/sim/setup';
import { loadWorldMap } from '../src/sim/worldmaps';
import type { BuildingType, Difficulty, DoctrineId, GameSettings, GameState, MapSize, MapType, Modifiers, Troops } from '../src/sim/types';

// No @types/node in this project: declare the few Node globals used here.
declare const process: { argv: string[]; exit(code?: number): never; stdout: { write(s: string): boolean } };

// ---------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------

interface Options {
  /** map sizes, or world:<id> for a real-world map */
  sizes: string[];
  mods: Partial<Modifiers>;
  ais: number[];
  maps: MapType[];
  seeds: number;
  start: number;
  minutes: number;
  tribes: number;
  difficulty: Difficulty;
  jobs: number;
  json: boolean;
  doctrines: 'ai' | 'random' | 'off';
  /** worker mode: run only jobs with index % of === shard and print JSON lines */
  shard: number;
  of: number;
}

function parseOptions(argv: string[]): Options {
  const args = argv.filter((a) => a !== '--');
  const o: Options = {
    sizes: ['small', 'medium', 'large'],
    mods: {},
    ais: [],
    maps: ['continents', 'archipelago', 'pangaea', 'highlands'],
    seeds: 4,
    start: 1,
    minutes: 55,
    tribes: -1,
    difficulty: 'normal',
    jobs: 4,
    json: false,
    doctrines: 'ai',
    shard: -1,
    of: 1,
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const v = args[k + 1];
    const list = (): string[] => (v ?? '').split(',').filter(Boolean);
    switch (a) {
      case '--sizes': o.sizes = list(); k++; break;
      case '--mods': {
        for (const item of list()) {
          const [key, raw] = item.split('=');
          const val = raw === undefined ? true : raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
          (o.mods as Record<string, unknown>)[key] = val;
        }
        k++;
        break;
      }
      case '--ais': o.ais = v === 'default' ? [] : list().map(Number); k++; break;
      case '--maps': o.maps = list() as MapType[]; k++; break;
      case '--seeds': o.seeds = Number(v); k++; break;
      case '--start': o.start = Number(v); k++; break;
      case '--minutes': o.minutes = Number(v); k++; break;
      case '--tribes': o.tribes = Number(v); k++; break;
      case '--difficulty': o.difficulty = v as Difficulty; k++; break;
      case '--jobs': o.jobs = Math.max(1, Number(v) || 1); k++; break;
      case '--json': o.json = true; break;
      case '--doctrines': o.doctrines = v as Options['doctrines']; k++; break;
      case '--shard': {
        const [s, of] = (v ?? '0/1').split('/').map(Number);
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

interface Job {
  index: number;
  /** map size, or world:<id> */
  size: string;
  ais: number;
  map: MapType;
  seed: number;
}

/** AI counts to run for a size: --ais, or the size's default. */
function aisFor(o: Options, size: string): number[] {
  return o.ais.length ? o.ais : [DEFAULT_AI_COUNT[size as MapSize] ?? SINGLE_PLAYER_NATIONS];
}

function jobList(o: Options): Job[] {
  const jobs: Job[] = [];
  for (const size of o.sizes) {
    for (const ais of aisFor(o, size)) {
      for (let k = 0; k < o.seeds; k++) {
        jobs.push({ index: jobs.length, size, ais, map: o.maps[k % o.maps.length], seed: o.start + k });
      }
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------------------------------------------

/** Army mix sample: troops of all alive nations (home + attacks + transports). */
interface MixSample {
  infantry: number;
  armor: number;
  artillery: number;
}

interface GameResult {
  job: Job;
  winner: number;
  winMinute: number; // -1 without a winner
  winReason: string;
  minutes: number; // game minutes played
  /** army totals of all nations at 10 / 20 / 30 min (null if the game ended before) */
  mixAt: (MixSample | null)[];
  /** winner's army summed over samples in the second half of the game (its usual mix) */
  winnerMix: MixSample | null;
  /** buildings ever started, per type */
  buildings: Partial<Record<BuildingType, number>>;
  /** mean techs per alive nation at 20 min (-1 if over) */
  techs20: number;
  /** tiles leader among nations at 8 min, 15 min (0 if over) */
  leader8: number;
  leader15: number;
  atomBombs: number;
  firstAtomMinute: number; // -1 none
  /** minute the first nation finished Nuclear Fission (-1 never) */
  fissionMinute: number;
  rockets: number;
  bombers: number;
  warships: number;
  invasions: number; // transports sent at another nation's coast
  /** allies.ts: an ally joined a war (allyJoined), sent aid (allyAid), refused a request (allyRefused) */
  allyJoins: number;
  allyAids: number;
  allyRefusals: number;
  /** seconds with a runaway leader (allies.runawayLeader), and that leader won */
  leaderSeconds: number;
  landings: number; // transports sent at neutral coast
  /** minute of each nation's / tribe's elimination */
  nationElims: number[];
  tribeElims: number[];
  nations: number;
  tribes: number;
  /** nation samples (every 10 s after minute 3) with a nearly full population and no attack of their own, not attacked */
  idleFull: number;
  /** same, but under attack (holding at home: their troops are the defence density) */
  holdFull: number;
  samples: number;
  /** biggest army of a nation (home + attacks + transports) seen at any sample */
  maxArmy: number;
  tickP50: number;
  tickP95: number;
  tickP99: number;
  tickMax: number;
  /** buildings standing at the end, per type: [sites, sum of levels, highest level] */
  endBuildings: Partial<Record<BuildingType, [number, number, number]>>;
  paradrops: number;
  paradropsShot: number;
  paradropsLanded: number;
  barrages: number;
  barragesSilencing: number;
  /** per barrage that landed: troops killed, and that / the target's home army when it was fired */
  barrageKills: number[];
  barrageShares: number[];
  /** fortified tiles (fort or watchtower cover) taken by another nation between two samples; by attackers whose
   *  attacks on that owner carried >= 15% artillery */
  fortTaken: number;
  fortTakenArt: number;
  bombersShot: number;
  missilesShot: number;
  /** abilities used by the winner and the mean per nation */
  winnerParadrops: number;
  winnerBarrages: number;
  meanParadrops: number;
  meanBarrages: number;
  /** per nation: the doctrine it held longest (10 s samples; null = never chose), its personality and switches */
  doctrines: { id: number; personality: string; doctrine: DoctrineId | null; switches: number; landShare: number; alive: boolean }[];
  /** the winner, or the land leader among nations at the cap (0 = none) */
  topNation: number;
  /** per nation: the member it chose in each exclusive tech group (done or researching; absent = none) */
  branches?: { id: number; picks: Record<string, string> }[];
  /** AI gold uses (aispending.ts counters) */
  spend?: AISpendStats;
  /** spearheads that ended: why (text), tiles taken, troops lost */
  spearheads?: { why: string; tiles: number; lost: number }[];
}

function wholeArmies(state: GameState): Float64Array {
  const army = new Float64Array(state.players.length);
  for (const a of state.attacks) army[a.attacker] += armyTotal(a.troops);
  for (const u of state.units) if (u.type === 'transport' || u.type === 'transportPlane') army[u.owner] += armyTotal(u.troops);
  for (const p of state.players) army[p.id] += armyTotal(p.troops);
  return army;
}

function nationTroops(state: GameState, id: number): Troops {
  const t: Troops = { ...state.players[id].troops };
  for (const a of state.attacks) {
    if (a.attacker !== id) continue;
    t.infantry += a.troops.infantry;
    t.armor += a.troops.armor;
    t.artillery += a.troops.artillery;
  }
  for (const u of state.units) {
    if (u.type !== 'transport' || u.owner !== id) continue;
    t.infantry += u.troops.infantry;
    t.armor += u.troops.armor;
    t.artillery += u.troops.artillery;
  }
  return t;
}

function tileLeader(state: GameState): number {
  let best = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || isTribe(p)) continue;
    if (!best || p.tiles > state.players[best].tiles) best = p.id;
  }
  return best;
}

async function runGame(job: Job, o: Options): Promise<GameResult> {
  const world = job.size.startsWith('world:') ? job.size.slice(6) : null;
  const settings: GameSettings = {
    ...cloneSetup(DEFAULT_SETUP),
    seed: job.seed,
    map: world ? { kind: 'world', id: world } : { kind: 'generated', type: job.map, size: job.size as MapSize },
    aiCount: job.ais,
    difficulty: o.difficulty,
    playerName: 'Nobody',
    playerColor: [255, 255, 255],
    humanPlayer: false,
    timeLimit: 0,
    victoryLandShare: VICTORY_LAND_SHARE,
    tribeCount: o.tribes,
    modifiers: { ...DEFAULT_MODIFIERS, ...o.mods },
  };
  const state = createGame(settings, world ? await loadWorldMap(world) : null);
  while (state.phase === 'spawn') {
    tick(state);
    state.events.length = 0;
  }
  const r: GameResult = {
    job,
    winner: 0,
    winMinute: -1,
    winReason: '',
    minutes: 0,
    mixAt: [null, null, null],
    winnerMix: null,
    buildings: {},
    techs20: -1,
    leader8: 0,
    leader15: 0,
    atomBombs: 0,
    firstAtomMinute: -1,
    fissionMinute: -1,
    rockets: 0,
    bombers: 0,
    warships: 0,
    invasions: 0,
    allyJoins: 0,
    allyAids: 0,
    allyRefusals: 0,
    leaderSeconds: 0,
    landings: 0,
    nationElims: [],
    tribeElims: [],
    nations: state.players.filter((p) => p.id !== 0 && !isTribe(p)).length,
    tribes: state.players.filter((p) => isTribe(p)).length,
    idleFull: 0,
    holdFull: 0,
    samples: 0,
    maxArmy: 0,
    tickP50: 0,
    tickP95: 0,
    tickP99: 0,
    tickMax: 0,
    endBuildings: {},
    paradrops: 0,
    paradropsShot: 0,
    paradropsLanded: 0,
    barrages: 0,
    barragesSilencing: 0,
    barrageKills: [],
    barrageShares: [],
    fortTaken: 0,
    fortTakenArt: 0,
    bombersShot: 0,
    missilesShot: 0,
    winnerParadrops: 0,
    winnerBarrages: 0,
    meanParadrops: 0,
    meanBarrages: 0,
    doctrines: [],
    branches: [],
    spearheads: [],
    topNation: 0,
  };
  const doctrineSamples = new Map<number, Map<DoctrineId, number>>();
  const lastDoctrine = new Map<number, DoctrineId>();
  const switches = new Map<number, number>();
  const dropsBy = new Map<number, number>();
  const barragesBy = new Map<number, number>();
  const barrageArmy = new Map<string, number[]>(); // 'owner:tile' -> target home armies at launch (fire order)
  const fortOwner = new Int32Array(state.map.owner.length); // owner of a fortified tile at the last sample
  let fortTiles: number[] = [];
  const seenUnits = new Set<number>();
  const seenBuildings = new Set<number>();
  const mixSamples: { minute: number; mix: Troops[] }[] = [];
  const tickMs: number[] = [];
  const cap = Math.round(o.minutes * 60 * TICKS_PER_SECOND);
  const sampleEvery = 10 * TICKS_PER_SECOND;
  // --doctrines random: a seeded pick per nation (script-side RNG, not the game's), applied at the unlock.
  let pickSeed = (job.seed * 2654435761) >>> 0;
  const nextPick = (): DoctrineId => {
    pickSeed = (Math.imul(pickSeed ^ (pickSeed >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    return DOCTRINE_IDS[pickSeed % DOCTRINE_IDS.length];
  };
  for (let k = 0; k < cap && state.phase === 'playing'; k++) {
    if (o.doctrines === 'random' && state.tick === doctrineUnlockTick(state)) {
      for (const p of state.players) if (p.id && p.alive && !isTribe(p)) applyAction(state, p.id, { type: 'chooseDoctrine', doctrine: nextPick() });
    }
    const t0 = performance.now();
    tick(state);
    tickMs.push(performance.now() - t0);
    // --doctrines off: every doctrine stays 'adapting' (no bonus), so the AIs play as before doctrines existed.
    if (o.doctrines === 'off') for (const p of state.players) if (p.doctrine?.id) p.doctrine.adaptUntilTick = 0x7fffffff;
    // --doctrines random: the switch cooldown never ends, so each nation keeps its random doctrine (levels still grow).
    if (o.doctrines === 'random') for (const p of state.players) if (p.doctrine?.id) p.doctrine.lastSwitchTick = state.tick;
    for (const e of state.events) {
      if (e.kind === 'victory') r.winReason = e.message.replace(/^.* wins: /, '');
      else if (e.kind === 'allyJoined') r.allyJoins++;
      else if (e.kind === 'allyAid') r.allyAids++;
      else if (e.kind === 'allyRefused') r.allyRefusals++;
      else if ((e.kind as string) === 'spearheadEnded') {
        const m = /spearhead (.*): (\d+) tiles taken, ([\d.]+)(k|M)? troops lost/.exec(e.message);
        if (m) r.spearheads!.push({ why: m[1], tiles: Number(m[2]), lost: Number(m[3]) * (m[4] === 'M' ? 1e6 : m[4] === 'k' ? 1e3 : 1) });
      }
      else if (e.kind === 'paradrop' && / landed in /.test(e.message)) r.paradropsLanded++;
      else if (e.kind === 'barrage' && / shelled /.test(e.message)) {
        if (/silenced/.test(e.message)) r.barragesSilencing++;
        const m = /: (\d+) troops lost/.exec(e.message);
        const army = barrageArmy.get(`${e.players[0]}:${e.tile}`)?.shift();
        if (m) {
          r.barrageKills.push(Number(m[1]));
          if (army && army > 0) r.barrageShares.push(Number(m[1]) / army);
        }
      }
      else if (e.kind === 'unitLost' && /shot down a cargo plane/.test(e.message)) r.paradropsShot++;
      else if (e.kind === 'unitLost' && /shot down a bomber/.test(e.message)) r.bombersShot++;
      else if (e.kind === 'unitLost' && /shot down a (rocket|atom bomb)/.test(e.message)) r.missilesShot++;
    }
    for (const b of state.barrages) {
      if (seenUnits.has(-b.id)) continue;
      seenUnits.add(-b.id);
      r.barrages++;
      const tp = state.players[b.target];
      const key = `${b.owner}:${b.tile}`;
      const q = barrageArmy.get(key) ?? [];
      q.push(tp ? armyTotal(tp.troops) : 0);
      barrageArmy.set(key, q);
      barragesBy.set(b.owner, (barragesBy.get(b.owner) ?? 0) + 1);
    }
    state.events.length = 0;
    state.effects.length = 0;
    const minute = gameSeconds(state) / 60;
    for (const u of state.units) {
      if (seenUnits.has(u.id)) continue;
      seenUnits.add(u.id);
      if (u.type === 'atomBomb') {
        r.atomBombs++;
        if (r.firstAtomMinute < 0) r.firstAtomMinute = minute;
      } else if (u.type === 'rocket') r.rockets++;
      else if (u.type === 'bomber') r.bombers++;
      else if (u.type === 'warship') r.warships++;
      else if (u.type === 'transportPlane') {
        r.paradrops++;
        dropsBy.set(u.owner, (dropsBy.get(u.owner) ?? 0) + 1);
      }
      else if (u.type === 'transport') {
        if (u.targetOwner > 0) r.invasions++;
        else r.landings++;
      }
    }
    if ((state.tick - state.playStartTick) % sampleEvery !== 0) continue;
    {
      const owner = state.map.owner;
      for (const i of fortTiles) {
        const was = fortOwner[i];
        const now = owner[i];
        fortOwner[i] = 0;
        if (now === was || now <= 0 || isTribe(state.players[now])) continue;
        r.fortTaken++;
        const t: Troops = { infantry: 0, armor: 0, artillery: 0 };
        for (const a of state.attacks) {
          if (a.attacker !== now || a.target !== was) continue;
          t.infantry += a.troops.infantry;
          t.armor += a.troops.armor;
          t.artillery += a.troops.artillery;
        }
        const tot = t.infantry + t.armor + t.artillery;
        if (tot > 0 && t.artillery / tot >= 0.15) r.fortTakenArt++;
      }
      fortTiles = [];
      for (const b of state.buildings.values()) {
        if ((b.type !== 'fort' && b.type !== 'watchtower') || b.owner <= 0 || isTribe(state.players[b.owner])) continue;
        const rad = b.type === 'fort' ? fortRadius(state, b) : WATCHTOWER_DEF_RADIUS;
        forEachInRadius(state.map, b.tile, rad, (i) => {
          if (owner[i] !== b.owner || fortOwner[i]) return;
          if (fortMultiplierAt(state, i, b.owner) <= 1.01) return;
          fortOwner[i] = b.owner;
          fortTiles.push(i);
        });
      }
    }
    for (const b of state.buildings.values()) {
      if (seenBuildings.has(b.id)) continue;
      seenBuildings.add(b.id);
      r.buildings[b.type] = (r.buildings[b.type] ?? 0) + 1;
    }
    const sec = Math.round(gameSeconds(state));
    if (r.fissionMinute < 0 && state.players.some((p) => p.alive && p.techs.includes('nuclearFission'))) r.fissionMinute = minute;
    const armies = wholeArmies(state);
    for (const p of state.players) if (p.id !== 0 && !isTribe(p) && armies[p.id] > r.maxArmy) r.maxArmy = armies[p.id];
    const perNation: Troops[] = [];
    for (const p of state.players) {
      if (p.id === 0 || isTribe(p) || !p.alive) {
        perNation.push({ infantry: 0, armor: 0, artillery: 0 });
        continue;
      }
      perNation.push(nationTroops(state, p.id));
      if (sec >= 180) {
        r.samples++;
        const own = state.attacks.some((a) => a.attacker === p.id);
        const units = state.units.some((u) => u.owner === p.id && u.type === 'transport');
        const hit = state.attacks.some((a) => a.target === p.id);
        if (!own && !units && p.maxPop > 0 && population(p) >= p.maxPop * 0.9 && armies[p.id] > 1000) {
          if (hit) r.holdFull++;
          else r.idleFull++;
        }
      }
    }
    mixSamples.push({ minute, mix: perNation });
    for (const p of state.players) {
      const d = p.doctrine?.id;
      if (!d || !p.alive) continue;
      const held = doctrineSamples.get(p.id) ?? new Map<DoctrineId, number>();
      held.set(d, (held.get(d) ?? 0) + 1);
      doctrineSamples.set(p.id, held);
      const was = lastDoctrine.get(p.id);
      if (was && was !== d) switches.set(p.id, (switches.get(p.id) ?? 0) + 1);
      lastDoctrine.set(p.id, d);
    }
    for (const [slot, at] of [[0, 600], [1, 1200], [2, 1800]] as const) {
      if (sec !== at) continue;
      const m: MixSample = { infantry: 0, armor: 0, artillery: 0 };
      for (const t of perNation) {
        m.infantry += t.infantry;
        m.armor += t.armor;
        m.artillery += t.artillery;
      }
      r.mixAt[slot] = m;
      if (slot === 1) {
        let n = 0;
        let techs = 0;
        for (const p of state.players) {
          if (p.id === 0 || isTribe(p) || !p.alive) continue;
          n++;
          techs += p.techs.length;
        }
        r.techs20 = n ? techs / n : -1;
      }
    }
    if (sec === 480) r.leader8 = tileLeader(state);
    if (runawayLeader(state) > 0) r.leaderSeconds += sampleEvery / TICKS_PER_SECOND;
    if (sec === 900) r.leader15 = tileLeader(state);
  }
  r.minutes = gameSeconds(state) / 60;
  r.winner = state.winner;
  r.topNation = state.winner || tileLeader(state);
  for (const p of state.players) {
    if (p.id === 0 || isTribe(p) || (p.eliminatedTick === -1 && !p.spawned)) continue;
    let best: DoctrineId | null = null;
    let most = 0;
    for (const [d, n] of doctrineSamples.get(p.id) ?? []) {
      if (n > most) {
        most = n;
        best = d;
      }
    }
    r.doctrines.push({
      id: p.id,
      personality: p.personality ?? 'human',
      doctrine: best,
      switches: switches.get(p.id) ?? 0,
      landShare: p.alive ? p.tiles / Math.max(1, state.map.landTileCount) : 0,
      alive: p.alive,
    });
  }
  for (const p of state.players) {
    if (p.id === 0 || isTribe(p) || (p.eliminatedTick === -1 && !p.spawned)) continue;
    const picks: Record<string, string> = {};
    for (const g of exclusiveGroups()) {
      const t = groupMembers(g).find((m) => p.techs.includes(m) || p.researching === m);
      if (t) picks[g] = t;
    }
    r.branches!.push({ id: p.id, picks });
  }
  r.spend = { ...aiSpendStats(state) };
  for (const b of state.buildings.values()) {
    if (b.owner <= 0 || !state.players[b.owner]?.alive) continue;
    const e = (r.endBuildings[b.type] ??= [0, 0, 0]);
    e[0]++;
    e[1] += b.level;
    e[2] = Math.max(e[2], b.level);
  }
  r.winnerParadrops = r.winner ? (dropsBy.get(r.winner) ?? 0) : 0;
  r.winnerBarrages = r.winner ? (barragesBy.get(r.winner) ?? 0) : 0;
  r.meanParadrops = r.paradrops / Math.max(1, r.nations);
  r.meanBarrages = r.barrages / Math.max(1, r.nations);
  r.winMinute = state.winner ? r.minutes : -1;
  for (const p of state.players) {
    if (p.id === 0 || p.alive || p.eliminatedTick < 0) continue;
    const m = (p.eliminatedTick - state.playStartTick) / TICKS_PER_SECOND / 60;
    if (m < 0) continue; // never spawned
    (isTribe(p) ? r.tribeElims : r.nationElims).push(m);
  }
  if (r.winner) {
    const from = r.minutes / 2;
    const m: MixSample = { infantry: 0, armor: 0, artillery: 0 };
    for (const s of mixSamples) {
      if (s.minute < from) continue;
      const t = s.mix[r.winner];
      m.infantry += t.infantry;
      m.armor += t.armor;
      m.artillery += t.artillery;
    }
    r.winnerMix = m;
  }
  tickMs.sort((a, b) => a - b);
  const q = (x: number): number => (tickMs.length ? tickMs[Math.min(tickMs.length - 1, Math.floor(tickMs.length * x))] : 0);
  r.tickP50 = q(0.5);
  r.tickP95 = q(0.95);
  r.tickP99 = q(0.99);
  r.tickMax = tickMs.length ? tickMs[tickMs.length - 1] : 0;
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------------------------

function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((100 * a) / b)}%` : '-');
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-');
function fmtArmy(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'k';
  return Math.round(v).toString();
}

function share(m: MixSample | null): { armor: number; artillery: number } | null {
  if (!m) return null;
  const t = m.infantry + m.armor + m.artillery;
  if (t <= 0) return null;
  return { armor: m.armor / t, artillery: m.artillery / t };
}

/** Troop mix label: the types that make up at least 15% of the army, e.g. "inf+arm". */
function mixLabel(m: MixSample | null): string {
  const s = share(m);
  if (!s) return '?';
  const inf = 1 - s.armor - s.artillery;
  const parts: string[] = [];
  if (inf >= 0.15) parts.push('inf');
  if (s.armor >= 0.15) parts.push('arm');
  if (s.artillery >= 0.15) parts.push('art');
  return parts.join('+') || 'inf';
}

function summary(title: string, rs: GameResult[]): void {
  const n = rs.length;
  if (!n) return;
  const won = rs.filter((r) => r.winner > 0);
  const winMins = won.map((r) => r.winMinute);
  const inWindow = won.filter((r) => r.winMinute >= 25 && r.winMinute <= 50).length;
  const mixCols = [0, 1, 2].map((slot) => {
    const ss = rs.map((r) => share(r.mixAt[slot])).filter((x): x is { armor: number; artillery: number } => !!x);
    if (!ss.length) return '   -/-  ';
    const a = ss.reduce((s, x) => s + x.armor, 0) / ss.length;
    const b = ss.reduce((s, x) => s + x.artillery, 0) / ss.length;
    return `${Math.round(a * 100)}/${Math.round(b * 100)}`.padStart(7);
  });
  const t20 = rs.filter((r) => r.techs20 >= 0).map((r) => r.techs20);
  const l8 = rs.filter((r) => r.winner > 0 && r.leader8 > 0);
  const l15 = rs.filter((r) => r.winner > 0 && r.leader15 > 0);
  const mixedWinners = won.filter((r) => {
    const s = share(r.winnerMix);
    return !!s && (s.armor >= 0.15 || s.artillery >= 0.15);
  }).length;
  const labels = new Set(won.map((r) => mixLabel(r.winnerMix)));
  const sum = (f: (r: GameResult) => number): number => rs.reduce((s, r) => s + f(r), 0);
  const games = (f: (r: GameResult) => boolean): number => rs.filter(f).length;
  const idle = sum((r) => r.idleFull) / Math.max(1, sum((r) => r.samples));
  const hold = sum((r) => r.holdFull) / Math.max(1, sum((r) => r.samples));
  console.log(
    [
      title.padEnd(22),
      String(n).padStart(3),
      pct(won.length, n).padStart(5),
      f1(median(winMins)).padStart(5),
      pct(inWindow, n).padStart(5),
      ...mixCols,
      `${pct(mixedWinners, won.length)} ${labels.size}`.padStart(8),
      f1(median(t20)).padStart(5),
      pct(l8.filter((r) => r.leader8 === r.winner).length, l8.length).padStart(5),
      pct(l15.filter((r) => r.leader15 === r.winner).length, l15.length).padStart(5),
      `${sum((r) => r.atomBombs)}/${games((r) => r.atomBombs > 0)}`.padStart(6),
      f1(median(rs.filter((r) => r.firstAtomMinute >= 0).map((r) => r.firstAtomMinute))).padStart(5),
      f1(median(rs.filter((r) => r.fissionMinute >= 0).map((r) => r.fissionMinute))).padStart(5),
      `${sum((r) => r.invasions)}/${games((r) => r.invasions > 0)}`.padStart(7),
      `${sum((r) => r.bombers)}/${games((r) => r.bombers > 0)}`.padStart(7),
      `${sum((r) => r.rockets)}`.padStart(5),
      `${sum((r) => r.warships)}`.padStart(5),
      `${Math.round(idle * 100)}/${Math.round(hold * 100)}%`.padStart(7),
      fmtArmy(median(rs.map((r) => r.maxArmy))).padStart(6),
      f1(median(rs.map((r) => r.tickP50))).padStart(5),
      f1(median(rs.map((r) => r.tickP95))).padStart(5),
      f1(Math.max(...rs.map((r) => r.tickP99))).padStart(5),
    ].join(' '),
  );
}

function header(): void {
  console.log(
    [
      'config'.padEnd(22),
      '  n',
      ' won%',
      ' tWin',
      '25-50',
      '10m a/r',
      '20m a/r',
      '30m a/r',
      ' mixW #',
      'tch20',
      ' ld8W',
      'ld15W',
      ' atom',
      't1atm',
      'tFiss',
      ' invade',
      ' bomber',
      ' rckt',
      ' wshp',
      'idl/hld',
      ' maxArmy'.slice(1).padStart(6),
      '  p50',
      '  p95',
      '  p99',
    ].join(' '),
  );
}

function report(rs: GameResult[], o: Options): void {
  console.log('\nPer configuration (a/r = armor/artillery % of all armies; mixW = winners with >= 15% armor or');
  console.log('artillery, # = distinct mixes; ld8W / ld15W = leader at 8 / 15 min won; atom and invade: count/games;');
  console.log('t1atm = median minute of the first atom bomb; tFiss = median minute the first nation had Nuclear Fission;');
  console.log('idl/hld = nation samples with troops >= 90% of the cap and no attack of their own, not attacked / attacked;');
  console.log('maxArmy = median over games of the biggest nation army; p50 / p95 / p99 ms per tick)\n');
  header();
  for (const size of o.sizes) {
    for (const ais of aisFor(o, size)) {
      summary(`${size} ${ais} AIs`, rs.filter((r) => r.job.size === size && r.job.ais === ais));
    }
  }
  console.log('');
  for (const map of o.maps) summary(`map ${map}`, rs.filter((r) => r.job.map === map));
  console.log('');
  summary('all', rs);

  // Winners' mixes.
  const won = rs.filter((r) => r.winner > 0);
  const labels = new Map<string, number>();
  for (const r of won) labels.set(mixLabel(r.winnerMix), (labels.get(mixLabel(r.winnerMix)) ?? 0) + 1);
  console.log(`\nWinner troop mixes (types >= 15% of the army, second half of the game): ${[...labels].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  const reasons = new Map<string, number>();
  for (const r of won) {
    const k = r.winReason.includes('land') ? 'land share' : r.winReason || '?';
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  console.log(`Win reasons: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);

  // Buildings.
  console.log('\nBuildings started (total over all games / games with at least one):');
  const line: string[] = [];
  for (const t of BUILDING_ORDER) {
    const total = rs.reduce((s, r) => s + (r.buildings[t] ?? 0), 0);
    const g = rs.filter((r) => (r.buildings[t] ?? 0) > 0).length;
    line.push(`${t} ${total}/${g}`);
  }
  console.log('  ' + line.join(', '));
  console.log('Standing at the end (sites / mean level / highest level), summed over games:');
  const end: string[] = [];
  for (const t of BUILDING_ORDER) {
    let sites = 0;
    let levels = 0;
    let top = 0;
    for (const r of rs) {
      const e = r.endBuildings?.[t];
      if (!e) continue;
      sites += e[0];
      levels += e[1];
      top = Math.max(top, e[2]);
    }
    end.push(`${t} ${sites}/${sites ? (levels / sites).toFixed(1) : '-'}/${top}`);
  }
  console.log('  ' + end.join(', '));
  const nationGames = rs.reduce((s, r) => s + r.nations, 0);
  const allSites = rs.reduce((s, r) => s + Object.values(r.endBuildings ?? {}).reduce((q, e) => q + (e ? e[0] : 0), 0), 0);
  console.log(`  ${f1(allSites / Math.max(1, rs.length))} buildings per game at the end, ${f1(allSites / Math.max(1, nationGames))} per nation (incl. dead ones)`);

  // Special abilities and interceptions.
  const tot = (f: (r: GameResult) => number): number => rs.reduce((s, r) => s + (f(r) || 0), 0);
  console.log(`\nParadrops: ${tot((r) => r.paradrops)} (${tot((r) => r.paradropsShot)} shot down, ${tot((r) => r.paradropsLanded)} landed on nations) in ${rs.filter((r) => r.paradrops > 0).length} games.`);
  console.log(`Barrages: ${tot((r) => r.barrages)} (${tot((r) => r.barragesSilencing)} silenced forts / SAMs) in ${rs.filter((r) => r.barrages > 0).length} games.`);
  const kills = rs.flatMap((r) => r.barrageKills ?? []);
  const shares = rs.flatMap((r) => r.barrageShares ?? []);
  console.log(`  per barrage: median ${Math.round(median(kills))} killed (mean ${Math.round(kills.reduce((a, b) => a + b, 0) / Math.max(1, kills.length))}), median ${(100 * median(shares)).toFixed(2)}% of the target's home army (p90 ${(100 * (shares.length ? [...shares].sort((a, b) => a - b)[Math.floor(shares.length * 0.9)] : NaN)).toFixed(2)}%)`);
  const ft = tot((r) => r.fortTaken);
  console.log(`Fortified tiles taken by nations: ${ft} (${f1(ft / Math.max(1, rs.length))} per game), ${pct(tot((r) => r.fortTakenArt), ft)} by attacks with >= 15% artillery.`);
  const artW = won.filter((r) => (share(r.winnerMix)?.artillery ?? 0) >= 0.15).length;
  console.log(`Winners with >= 15% artillery: ${artW} of ${won.length} (${pct(artW, won.length)}).`);
  console.log(`Shot down: ${tot((r) => r.bombersShot)} of ${tot((r) => r.bombers)} bombers, ${tot((r) => r.missilesShot)} of ${tot((r) => r.rockets + r.atomBombs)} missiles.`);
  const wonGames = rs.filter((r) => r.winner > 0);
  if (wonGames.length) {
    const wd = wonGames.reduce((s, r) => s + r.winnerParadrops, 0) / wonGames.length;
    const md = wonGames.reduce((s, r) => s + r.meanParadrops, 0) / wonGames.length;
    const wb = wonGames.reduce((s, r) => s + r.winnerBarrages, 0) / wonGames.length;
    const mb = wonGames.reduce((s, r) => s + r.meanBarrages, 0) / wonGames.length;
    console.log(`Winners used ${f1(wd)} paradrops (nation mean ${f1(md)}) and ${f1(wb)} barrages (nation mean ${f1(mb)}) per game.`);
  }

  // Eliminations over time.
  const bins = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const hist = (vals: number[]): string =>
    bins.map((b, k) => vals.filter((v) => v >= (k ? bins[k - 1] : 0) && v < b).length).join(' / ');
  const nationTotal = rs.reduce((s, r) => s + r.nations, 0);
  const tribeTotal = rs.reduce((s, r) => s + r.tribes, 0);
  console.log(`\nEliminations per 5-minute bin (0-5 / 5-10 / ... / 50-55 min):`);
  console.log(`  nations (${nationTotal} total): ${hist(rs.flatMap((r) => r.nationElims))}`);
  console.log(`  tribes  (${tribeTotal} total): ${hist(rs.flatMap((r) => r.tribeElims))}`);
  const g = Math.max(1, rs.length);
  console.log(
    `\nAllies: ${f1(tot((r) => r.allyJoins) / g)} joined wars, ${f1(tot((r) => r.allyAids) / g)} aid shipments, ` +
      `${f1(tot((r) => r.allyRefusals) / g)} refusals per game; a runaway leader (coalition) for ${f1(tot((r) => r.leaderSeconds) / g / 60)} min per game.`,
  );
  console.log(`\nNaval: ${rs.reduce((s, r) => s + r.invasions, 0)} invasions, ${rs.reduce((s, r) => s + r.landings, 0)} landings on neutral coasts, ${rs.reduce((s, r) => s + r.warships, 0)} warships.`);
  const atomMins = rs.filter((r) => r.firstAtomMinute >= 0).map((r) => r.firstAtomMinute.toFixed(1));
  console.log(`Atom bombs: ${rs.reduce((s, r) => s + r.atomBombs, 0)} in ${atomMins.length} games, first at minute ${atomMins.join(', ') || '-'}.`);
  const p99s = rs.map((r) => r.tickP99);
  console.log(`Tick time: median p50 ${f1(median(rs.map((r) => r.tickP50)))} ms, median p95 ${f1(median(rs.map((r) => r.tickP95)))} ms, median p99 ${f1(median(p99s))} ms, worst p99 ${f1(Math.max(...p99s))} ms, worst tick ${f1(Math.max(...rs.map((r) => r.tickMax)))} ms.`);
  doctrineReport(rs);
  branchReport(rs);
}

/**
 * Tech branches: per exclusive group, how often each member was chosen and won (win share / pick share among the
 * nations that chose in that group; > 1.5 flagged), AI gold uses per game, and spearhead outcomes by how they ended.
 */
function branchReport(rs: GameResult[]): void {
  console.log('\nTech branches (nations that chose in the group; win = winner or land leader at the cap):');
  console.log('  group          member              picks  pick%   wins  win%  win%/pick%');
  for (const g of exclusiveGroups()) {
    let chose = 0;
    let decided = 0;
    const picks = new Map<string, number>();
    const wins = new Map<string, number>();
    for (const r of rs) {
      const top = r.branches?.find((b) => b.id === r.topNation);
      if (top?.picks[g]) decided++;
      for (const b of r.branches ?? []) {
        const t = b.picks[g];
        if (!t) continue;
        chose++;
        picks.set(t, (picks.get(t) ?? 0) + 1);
        if (b.id === r.topNation) wins.set(t, (wins.get(t) ?? 0) + 1);
      }
    }
    for (const t of groupMembers(g)) {
      const n = picks.get(t) ?? 0;
      const w = wins.get(t) ?? 0;
      const ratio = n && decided ? w / decided / (n / chose) : NaN;
      const flag = ratio > 1.5 && w >= 3 ? '  <-- high' : '';
      console.log(`  ${g.padEnd(14)} ${t.padEnd(18)} ${String(n).padStart(6)} ${pct(n, chose).padStart(6)} ${String(w).padStart(6)} ${pct(w, decided).padStart(5)}   ${f1(ratio).padStart(5)}${flag}`);
    }
  }
  const g = Math.max(1, rs.length);
  const sum = (f: (s: AISpendStats) => number): number => rs.reduce((a, r) => a + (r.spend ? f(r.spend) : 0), 0);
  console.log(
    `AI gold uses per game: ${f1(sum((s) => s.mercHires) / g)} mercenary hires (${f1(sum((s) => s.mercTroops) / g / 1000)}k troops), ` +
      `${f1(sum((s) => s.fundings) / g)} ally fundings (${f1(sum((s) => s.fundGold) / g / 1000)}k gold), ${f1(sum((s) => s.bonds) / g)} war bonds, ` +
      `${f1(sum((s) => s.bulkOrders) / g)} bulk city orders, ${f1(sum((s) => s.areaOrders) / g)} area upgrades; ` +
      `games with mercenaries ${rs.filter((r) => (r.spend?.mercHires ?? 0) > 0).length}/${rs.length}, with funding ${rs.filter((r) => (r.spend?.fundings ?? 0) > 0).length}/${rs.length}.`,
  );
  const sh = rs.flatMap((r) => r.spearheads ?? []);
  if (sh.length) {
    const why = new Map<string, { n: number; tiles: number; lost: number }>();
    for (const x of sh) {
      const k = x.why.replace(/ (against|into|near|at) .*/, '');
      const e = why.get(k) ?? { n: 0, tiles: 0, lost: 0 };
      e.n++;
      e.tiles += x.tiles;
      e.lost += x.lost;
      why.set(k, e);
    }
    console.log(`Spearheads: ${sh.length} (${f1(sh.length / g)} per game), median ${median(sh.map((x) => x.tiles))} tiles taken; by ending:`);
    for (const [k, e] of [...why].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${k.padEnd(34)} ${String(e.n).padStart(5)}  mean ${f1(e.tiles / e.n)} tiles, ${f1(e.lost / e.n / 1000)}k lost`);
    }
  } else console.log('Spearheads: none.');
}

// ---------------------------------------------------------------------------------------------------------------
// Main: in-process or sharded over worker processes
// ---------------------------------------------------------------------------------------------------------------

/** Doctrine picks by personality, switches, and win rate per doctrine vs its pick share (flag > 1.5x). */
function doctrineReport(rs: GameResult[]): void {
  const picks = new Map<string, number>();
  const wins = new Map<string, number>();
  const land = new Map<string, number>();
  const alive = new Map<string, number>();
  const byPers = new Map<string, Map<string, number>>();
  let nations = 0;
  let switched = 0;
  let switchCount = 0;
  let decided = 0;
  for (const r of rs) {
    if (r.topNation) decided++;
    for (const d of r.doctrines) {
      const k = d.doctrine ?? 'none';
      nations++;
      picks.set(k, (picks.get(k) ?? 0) + 1);
      land.set(k, (land.get(k) ?? 0) + (d.landShare ?? 0));
      if (d.alive) alive.set(k, (alive.get(k) ?? 0) + 1);
      if (d.id === r.topNation) wins.set(k, (wins.get(k) ?? 0) + 1);
      const m = byPers.get(d.personality) ?? new Map<string, number>();
      m.set(k, (m.get(k) ?? 0) + 1);
      byPers.set(d.personality, m);
      if (d.switches > 0) switched++;
      switchCount += d.switches;
    }
  }
  console.log(`\nDoctrines (held longest; ${nations} nations in ${rs.length} games, ${decided} with a winner or land leader):`);
  console.log(`  doctrine    picks  pick%   wins  win%   win%/pick%   land at end  alive at end`);
  for (const k of [...DOCTRINE_IDS, 'none']) {
    const n = picks.get(k) ?? 0;
    if (!n) continue;
    const w = wins.get(k) ?? 0;
    const pickShare = n / Math.max(1, nations);
    const winShare = w / Math.max(1, decided);
    const ratio = pickShare > 0 ? winShare / pickShare : NaN;
    const flag = ratio > 1.5 && w >= 3 ? '  <-- high' : '';
    const landMean = (100 * (land.get(k) ?? 0)) / n;
    console.log(
      `  ${k.padEnd(10)} ${String(n).padStart(6)} ${pct(n, nations).padStart(6)} ${String(w).padStart(6)} ${pct(w, decided).padStart(5)}   ${f1(ratio).padStart(5)}` +
        `        ${f1(landMean).padStart(5)}%      ${pct(alive.get(k) ?? 0, n).padStart(5)}${flag}`,
    );
  }
  console.log(`  ${switched} nations switched (${switchCount} switches, ${f1(switchCount / Math.max(1, nations))} per nation)`);
  const persWins = new Map<string, number>();
  for (const r of rs) {
    const d = r.doctrines.find((x) => x.id === r.topNation);
    if (d) persWins.set(d.personality, (persWins.get(d.personality) ?? 0) + 1);
  }
  for (const [pers, m] of byPers) {
    const n = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${pers.padEnd(9)} won ${persWins.get(pers) ?? 0} of ${n} nations; held: ${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}

async function runShards(o: Options, argv: string[]): Promise<GameResult[]> {
  // Dynamic import keeps the module graph free of Node types (the sim and client never load this file).
  const cp = (await import('node:child_process')) as unknown as {
    spawn(cmd: string, args: string[], opts: object): {
      stdout: { on(ev: 'data', f: (b: unknown) => void): void };
      stderr: { on(ev: 'data', f: (b: unknown) => void): void };
      on(ev: 'close', f: (code: number) => void): void;
    };
  };
  const rest = argv.filter((a) => a !== '--');
  const out: GameResult[] = [];
  await Promise.all(
    Array.from({ length: o.jobs }, (_, s) =>
      new Promise<void>((resolve, reject) => {
        const child = cp.spawn('node_modules/.bin/vite-node', ['scripts/batch.ts', '--', ...rest, '--shard', `${s}/${o.jobs}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        child.stdout.on('data', (b) => {
          buf += String(b);
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const lineText = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!lineText.startsWith('{')) continue;
            const r = JSON.parse(lineText) as GameResult;
            out.push(r);
            progress(r, o);
          }
        });
        child.stderr.on('data', (b) => process.stdout.write(String(b)));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${s} exited with ${code}`))));
      }),
    ),
  );
  return out.sort((a, b) => a.job.index - b.job.index);
}

function progress(r: GameResult, o: Options): void {
  const j = r.job;
  const w = r.winner ? `winner ${r.winner} at ${r.winMinute.toFixed(1)} (${r.winReason})` : `no winner after ${r.minutes.toFixed(1)}`;
  console.log(`#${j.index} ${j.size} ${j.ais} AIs ${j.map} seed ${j.seed}: ${w}, biggest army ${fmtArmy(r.maxArmy)}, p50/p95/p99 ${r.tickP50.toFixed(1)}/${r.tickP95.toFixed(1)}/${r.tickP99.toFixed(1)} ms`);
  if (o.json) console.log('JSON ' + JSON.stringify(r));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const o = parseOptions(argv);
  const jobs = jobList(o);
  if (o.shard >= 0) {
    for (const j of jobs) if (j.index % o.of === o.shard) process.stdout.write(JSON.stringify(await runGame(j, o)) + '\n');
    return;
  }
  console.log(`Frontline Atlas batch: ${jobs.length} games (${o.sizes.join(',')} x ${o.ais.length ? o.ais.join(',') : 'default'} AIs x ${o.seeds} seeds from ${o.start}, maps ${o.maps.join(',')}), cap ${o.minutes} min, ${o.difficulty}, ${o.jobs} job(s).`);
  const t0 = performance.now();
  let results: GameResult[];
  if (o.jobs <= 1) {
    results = [];
    for (const j of jobs) {
      const r = await runGame(j, o);
      results.push(r);
      progress(r, o);
    }
  } else results = await runShards(o, argv);
  report(results, o);
  console.log(`\nDone in ${((performance.now() - t0) / 1000).toFixed(0)} s.`);
}

void main();
