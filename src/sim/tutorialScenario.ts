// The tutorial scenario: one small hand-made map and one safe practice setup (single player only).
//
// The client builds the game with createTutorialGame() (= createGame(tutorialSettings(), tutorialMap()) then
// setupTutorial) and calls the helpers below directly between ticks: no Action, no protocol, so multiplayer and
// normal games never see any of this. state.tutorial (types.ts TutorialState, part of the hash) turns on the rules:
//   - the taught player can't be eliminated: attacks and spearheads on it stop at TUTORIAL_MIN_TILES, it never
//     collapses or gets absorbed, and updateTutorial revives it at home if it ever falls;
//   - the game never ends (victory.ts);
//   - AIs in TutorialState.frozen make no decisions (ai.ts) until tutorialWake; no AI may attack the taught player
//     until a woken AI is made hostile (the owner console's aiPassive list, admin.ts).
// The map: the player picks a start in a spawn phase that waits for them; a grey tribe to the north-east and a weak,
// frozen nation to the east are both one short expansion away.
// Deterministic: fixed seed, no Math.random / Date.
import { adminState, applyAdmin } from './admin';
import { TECHS } from './config';
import { forEachInRadius } from './grid';
import { computeCoastAndLand, createMapData } from './mapgen';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP } from './setup';
import { createGame, setOwner } from './state';
import { isTribe, isWater, Terrain } from './types';
import type { GameSettings, GameState, MapData, TechId, TutorialChapterId, TutorialState } from './types';
import { unitQueue } from './navy';

export type { TutorialChapterId } from './types';

/** The tutorial's id (TutorialState.chapter). There is one tutorial; 'basics' also marks it done in saved progress. */
export const TUTORIAL_ID: TutorialChapterId = 'basics';
/** The tutorial map: mainland x 0..131, a strait x 132..143, an island x 144..199. */
export const TUTORIAL_MAP_WIDTH = 200;
export const TUTORIAL_MAP_HEIGHT = 128;
/** Attacks on the taught player stop when it is down to this many tiles. */
export const TUTORIAL_MIN_TILES = 40;
/** Spawn phase length (the player picks a start; tutorialStart or the Start button ends it). */
export const TUTORIAL_SPAWN_SECONDS = 600;

type XY = readonly [number, number];

/** Resources and techs the scenario (or a step) grants. troops = infantry. */
export interface TutorialGrant {
  gold?: number;
  iron?: number;
  oil?: number;
  science?: number;
  techs?: TechId[];
  troops?: number;
  armor?: number;
  artillery?: number;
}

interface NationSpec {
  role: string;
  cap: XY;
  /** a rectangle of land (x0, y0, x1, y1, inclusive) */
  land: readonly [number, number, number, number];
  troops: number;
}
interface TribeSpec {
  role: string;
  cap: XY;
  troops: number;
  /** land radius */
  r: number;
}

const HOME: XY = [40, 64];
const SPEC = {
  /** the suggested start (Show me) */
  home: HOME,
  grant: { gold: 1500 } as TutorialGrant,
  /** weak and frozen: the "attack a neighbour" step */
  nations: [{ role: 'rival', cap: [76, 78], land: [56, 58, 96, 98], troops: 3000 }] as NationSpec[],
  // its capital stays well clear of the no-spawn radius around it (state.ts spawnMinDistance) at the suggested start
  tribes: [{ role: 'tribe', cap: [52, 43], troops: 4000, r: 8 }] as TribeSpec[],
  /** named tiles for steps and Show me ('home', 'wild' and 'front' follow the game, see tutorialTile) */
  tiles: { spawn: HOME, citySite: HOME, wild: [46, 64], tribe: [52, 43], rival: [76, 78], front: [56, 66] } as Record<string, XY>,
};
const SEED = 7101;

/** Named tile keys (tutorialTile); 'home' is the player's capital. */
export const TUTORIAL_TILE_KEYS: string[] = ['home', ...Object.keys(SPEC.tiles)];
/** Player roles (tutorialPlayer). */
export const TUTORIAL_ROLES: string[] = [...SPEC.nations.map((n) => n.role), ...SPEC.tribes.map((t) => t.role)];

// ------------------------------------------------------------------------------------------------ settings and map

/** Settings of the tutorial game: the tutorial map's size class, a fixed seed, its AI and tribe, fast building. */
export function tutorialSettings(player?: { name?: string; color?: [number, number, number] }): GameSettings {
  return {
    ...cloneSetup(DEFAULT_SETUP),
    seed: SEED,
    map: { kind: 'generated', type: 'continents', size: 'small' },
    aiCount: SPEC.nations.length,
    tribeCount: SPEC.tribes.length,
    difficulty: 'easy',
    mode: 'ffa',
    teamCount: 2,
    timeLimit: 0,
    victoryLandShare: 0.95,
    modifiers: { ...DEFAULT_MODIFIERS, buildSpeed: 'fast' },
    preset: 'custom',
    playerName: player?.name || 'Commander',
    playerColor: player?.color ?? [70, 140, 230],
    humanPlayer: true,
  };
}

/** The tutorial map (a fresh copy each call: createGame takes ownership of it). Plain land, no deposits. */
export function tutorialMap(): MapData {
  const W = TUTORIAL_MAP_WIDTH;
  const H = TUTORIAL_MAP_HEIGHT;
  const map = createMapData(W, H);
  const put = (x: number, y: number, t: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) map.terrain[y * W + x] = t;
  };
  const blob = (cx: number, cy: number, r: number, t: number): void => {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(x, y, t);
  };
  map.terrain.fill(Terrain.Plains);
  // The strait: shallow edges, deep middle.
  for (let y = 0; y < H; y++) for (let x = 132; x <= 143; x++) put(x, y, x <= 133 || x >= 142 ? Terrain.ShallowWater : Terrain.DeepWater);
  // Scenery, away from the start, the tribe and the neighbour.
  blob(20, 40, 6, Terrain.Forest);
  blob(20, 92, 5, Terrain.Hills);
  blob(10, 64, 4, Terrain.Forest);
  blob(176, 40, 6, Terrain.Forest);
  blob(176, 92, 6, Terrain.Hills);
  blob(192, 64, 4, Terrain.Desert);
  blob(60, 10, 5, Terrain.Mountains);
  computeCoastAndLand(map);
  return map;
}

// ------------------------------------------------------------------------------------------------ setup

const at = (xy: XY): number => xy[1] * TUTORIAL_MAP_WIDTH + xy[0];

/** Gives pid the free land in `tiles` and its capital; marks it spawned with these troops. */
function claim(state: GameState, pid: number, tiles: number[], capital: number, infantry: number): void {
  const p = state.players[pid];
  if (state.map.owner[capital] !== 0 && state.map.owner[capital] !== pid) throw new Error(`Tutorial: capital of ${pid} is taken`);
  for (const t of tiles) if (state.map.owner[t] === 0) setOwner(state, t, pid);
  if (state.map.owner[capital] !== pid) setOwner(state, capital, pid);
  p.capital = capital;
  p.heartTile = isTribe(p) ? -1 : capital;
  p.heartMoveTick = 0;
  p.spawned = true;
  p.alive = true;
  p.eliminatedTick = -1;
  p.troops = { infantry, armor: 0, artillery: 0 };
}

/**
 * Sets the tutorial up right after createGame(tutorialSettings(), tutorialMap()): the tribe and the neighbour at their
 * places (frozen), the start gold and the tutorial rules (state.tutorial). The player then picks a start in a long
 * spawn phase.
 */
export function setupTutorial(state: GameState): void {
  if (state.map.width !== TUTORIAL_MAP_WIDTH || state.map.height !== TUTORIAL_MAP_HEIGHT) {
    throw new Error('setupTutorial: create the game with createGame(tutorialSettings(), tutorialMap()) (or createTutorialGame)');
  }
  const human = state.players.find((p) => p.isHuman)?.id ?? 0;
  if (human <= 0) throw new Error('setupTutorial: no human player');
  const nationIds = SPEC.nations.map((_, k) => human + 1 + k);
  const tribeIds = SPEC.tribes.map((_, k) => human + 1 + SPEC.nations.length + k);
  const tut: TutorialState = {
    chapter: TUTORIAL_ID,
    human,
    noElimination: true,
    minTiles: TUTORIAL_MIN_TILES,
    home: at(SPEC.home),
    frozen: [...nationIds, ...tribeIds].sort((a, b) => a - b),
    doctrinesEarly: false,
  };
  state.tutorial = tut;
  // Nobody may attack the player until a step makes an AI hostile (tutorialWake).
  adminState(state).aiPassive = [human];

  for (const [k, t] of SPEC.tribes.entries()) {
    const tiles: number[] = [];
    forEachInRadius(state.map, at(t.cap), t.r, (i) => {
      if (!isWater(state.map.terrain[i])) tiles.push(i);
    });
    claim(state, tribeIds[k], tiles.sort((a, b) => a - b), at(t.cap), t.troops);
  }
  for (const [k, n] of SPEC.nations.entries()) {
    const [x0, y0, x1, y1] = n.land;
    const tiles: number[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!isWater(state.map.terrain[at([x, y])])) tiles.push(at([x, y]));
    claim(state, nationIds[k], tiles, at(n.cap), n.troops);
  }
  state.spawnPoints[human] = at(SPEC.home);
  // the Research panel is the player's to drive (the research step picks a tech by hand)
  state.players[human].auto.research = false;
  state.spawnLeft = TUTORIAL_SPAWN_SECONDS;
  tutorialGrant(state, human, SPEC.grant);
}

/** createGame + setupTutorial: the whole game, ready to tick. */
export function createTutorialGame(player?: { name?: string; color?: [number, number, number] }): GameState {
  const state = createGame(tutorialSettings(player), tutorialMap());
  setupTutorial(state);
  return state;
}

// ------------------------------------------------------------------------------------------------ helpers for steps

function addTech(techs: TechId[], t: TechId): void {
  if (techs.includes(t)) return;
  const info = TECHS[t];
  if (!info) return;
  for (const r of info.requires) addTech(techs, r);
  if (info.requiresAny?.length && !info.requiresAny.some((x) => techs.includes(x))) addTech(techs, info.requiresAny[0]);
  techs.push(t);
}

/** Adds resources, troops (at home) and techs (with their prerequisites; the first option of an OR prerequisite). */
export function tutorialGrant(state: GameState, pid: number, g: TutorialGrant): void {
  const p = state.players[pid];
  if (!p || pid === 0) return;
  const add = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  p.gold += add(g.gold);
  p.iron += add(g.iron);
  p.oil += add(g.oil);
  p.science += add(g.science);
  p.troops.infantry += add(g.troops);
  p.troops.armor += add(g.armor);
  p.troops.artillery += add(g.artillery);
  for (const t of g.techs ?? []) addTech(p.techs, t);
  if (p.researching && p.techs.includes(p.researching)) {
    p.researching = null;
    p.researchProgress = 0;
  }
}

/**
 * Lets AIs decide again ('all' = every frozen one). hostile: they may also attack the taught player (it still can't
 * be eliminated).
 */
export function tutorialWake(state: GameState, aiIds: number[] | 'all', opts: { hostile?: boolean } = {}): void {
  const t = state.tutorial;
  if (!t) return;
  t.frozen = aiIds === 'all' ? [] : t.frozen.filter((id) => !aiIds.includes(id));
  if (opts.hostile) adminState(state).aiPassive = adminState(state).aiPassive.filter((id) => id !== t.human);
}

/** Freezes AIs again (they stop deciding; running attacks go on). */
export function tutorialFreeze(state: GameState, aiIds: number[]): void {
  const t = state.tutorial;
  if (!t) return;
  for (const id of aiIds) if (id > 0 && id !== t.human && !t.frozen.includes(id)) t.frozen.push(id);
  t.frozen.sort((a, b) => a - b);
}

/**
 * Sets a frozen AI's army to `infantry` (an "attack it" step: frozen AIs still grow troops, so a weak neighbour would
 * not stay weak on its own). Not the taught player, not an awake AI.
 */
export function tutorialWeaken(state: GameState, aiId: number, infantry: number): void {
  const t = state.tutorial;
  const p = state.players[aiId];
  if (!t || !p || aiId === t.human || !t.frozen.includes(aiId) || !(infantry >= 0)) return;
  p.troops = { infantry: Math.min(p.troops.infantry, infantry), armor: 0, artillery: 0 };
}

/** Makes an AI attack the taught player now across their shared border with 40% of its troops (a "defend" step). */
export function tutorialEnemyAttack(state: GameState, aiId: number): boolean {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing') return false;
  return applyAdmin(state, t.human, { type: 'admin', op: 'declareWar', player: aiId, other: t.human }).ok;
}

/** Finishes the player's constructions, upgrades, research, Arsenal orders and queued warships / tank divisions now. */
export function tutorialFinish(state: GameState, pid: number): void {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing') return;
  applyAdmin(state, t.human, { type: 'admin', op: 'finishConstructions', player: pid });
  const tp = state.players[pid];
  if (tp && (tp.researching || tp.procuring?.length)) applyAdmin(state, t.human, { type: 'admin', op: 'finishResearch', player: pid });
  for (const q of unitQueue(state)) if (q.owner === pid && q.readyTick > state.tick) q.readyTick = state.tick;
}

/** Ends the spawn phase on the next tick once the player has picked a start (like the Start button). */
export function tutorialStart(state: GameState): boolean {
  const t = state.tutorial;
  if (!t || state.phase !== 'spawn' || !state.players[t.human]?.spawned) return false;
  state.spawnLeft = Math.min(state.spawnLeft, 1e-6);
  return true;
}

/**
 * A named tile (TUTORIAL_TILE_KEYS), or -1. 'home' and 'citySite' are the player's capital (or the suggested start),
 * 'wild' free land at the player's border, 'front' the neighbour's land at the player's border.
 */
export function tutorialTile(state: GameState, key: string): number {
  if (!state.tutorial) return -1;
  if (key === 'home' || key === 'citySite') {
    const p = state.players[state.tutorial.human];
    return p && p.alive && p.capital >= 0 ? p.capital : at(SPEC.home);
  }
  if (key === 'wild') {
    const w = borderWild(state);
    if (w >= 0) return w;
  }
  if (key === 'front') {
    const f = borderEnemy(state, tutorialPlayer(state, 'rival'));
    if (f >= 0) return f;
  }
  const xy = Object.prototype.hasOwnProperty.call(SPEC.tiles, key) ? SPEC.tiles[key] : undefined;
  return xy ? at(xy) : -1;
}

/** Free land right at the player's border, nearest the capital (east first), or -1 before the spawn. */
function borderWild(state: GameState): number {
  const t = state.tutorial!;
  const p = state.players[t.human];
  if (!p || !p.alive || p.capital < 0) return -1;
  const map = state.map;
  const w = map.width;
  const cx = p.capital % w;
  const cy = (p.capital / w) | 0;
  for (let r = 1; r <= 40; r++) {
    for (const [dx, dy] of [[r, 0], [0, -r], [0, r], [-r, 0]] as const) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= map.height) continue;
      const i = y * w + x;
      if (map.owner[i] !== 0 || isWater(map.terrain[i])) continue;
      if (map.owner[(y - Math.sign(dy)) * w + (x - Math.sign(dx))] === t.human) return i;
    }
  }
  return -1;
}

/** A tile of `enemy` next to the player's land (4-neighbour), nearest the player's capital, or -1. */
function borderEnemy(state: GameState, enemy: number): number {
  const t = state.tutorial!;
  const p = state.players[t.human];
  if (enemy <= 0 || !p || p.capital < 0) return -1;
  const map = state.map;
  const w = map.width;
  const cx = p.capital % w;
  const cy = (p.capital / w) | 0;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < map.owner.length; i++) {
    if (map.owner[i] !== enemy) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const touches = (x > 0 && map.owner[i - 1] === t.human) || (x < w - 1 && map.owner[i + 1] === t.human) || (y > 0 && map.owner[i - w] === t.human) || (y < map.height - 1 && map.owner[i + w] === t.human);
    if (!touches) continue;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Player id of a role (TUTORIAL_ROLES: 'rival', 'tribe'; 'me' = the player), or 0. */
export function tutorialPlayer(state: GameState, role: string): number {
  const human = state.tutorial?.human ?? 1;
  if (role === 'me' || role === 'human') return human;
  const n = SPEC.nations.findIndex((x) => x.role === role);
  if (n >= 0) return human + 1 + n;
  const k = SPEC.tribes.findIndex((x) => x.role === role);
  return k >= 0 ? human + 1 + SPEC.nations.length + k : 0;
}

// ------------------------------------------------------------------------------------------------ tick

/** Once per tick (sim.ts): keeps `home` on the capital and revives the taught player if it ever fell. */
export function updateTutorial(state: GameState): void {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing') return;
  const p = state.players[t.human];
  if (!p) return;
  if (p.alive) {
    if (p.capital >= 0 && p.capital !== t.home) t.home = p.capital;
    return;
  }
  if (!t.noElimination) return;
  const map = state.map;
  const tiles: number[] = [];
  forEachInRadius(map, t.home, 4, (i) => {
    if (!isWater(map.terrain[i])) tiles.push(i);
  });
  tiles.sort((a, b) => a - b);
  if (!tiles.length) return;
  p.alive = true;
  p.spawned = true;
  p.eliminatedTick = -1;
  p.troops = { infantry: Math.max(10000, p.troops.infantry), armor: p.troops.armor, artillery: p.troops.artillery };
  for (const i of tiles) if (map.owner[i] !== t.human) setOwner(state, i, t.human);
  const cap = map.owner[t.home] === t.human ? t.home : tiles[0];
  p.capital = cap;
  p.heartTile = cap;
  p.heartMoveTick = 0;
}
