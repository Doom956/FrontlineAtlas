// Tutorial scenarios: one small hand-made map and one safe practice setup per chapter (single player only).
//
// The client builds a chapter's game with createTutorialGame(ch) (= createGame(tutorialSettings(ch), tutorialMap(ch))
// then setupTutorial) and calls the helpers below directly between ticks: no Action, no protocol, so multiplayer and
// normal games never see any of this. state.tutorial (types.ts TutorialState, part of the hash) turns on the rules:
//   - the taught player can't be eliminated: attacks and spearheads on it stop at TUTORIAL_MIN_TILES, it never
//     collapses or gets absorbed, and updateTutorial revives it at home if it ever falls;
//   - the game never ends (victory.ts);
//   - AIs in TutorialState.frozen make no decisions (ai.ts) until tutorialWake; no AI may attack the taught player
//     until a woken AI is made hostile (the owner console's aiPassive list, admin.ts);
//   - doctrines open at 0:00 in every chapter but Basics (doctrines.ts).
// Deterministic: fixed seeds, no Math.random / Date.
import { applyAdmin, adminState } from './admin';
import { TECHS } from './config';
import { forEachInRadius } from './grid';
import { computeCoastAndLand, createMapData } from './mapgen';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP } from './setup';
import { createGame, setOwner } from './state';
import { isTribe, isWater, Resource, Terrain } from './types';
import type { BuildingType, GameSettings, GameState, MapData, TechId, TutorialChapterId, TutorialState } from './types';
import { unitQueue } from './navy';

export type { TutorialChapterId } from './types';

export const TUTORIAL_CHAPTER_IDS: readonly TutorialChapterId[] = ['basics', 'war', 'economy', 'navy', 'armor', 'air', 'arsenal', 'diplomacy'];
/** The tutorial map (every chapter): mainland x 0..131, a strait x 132..143, an island x 144..199. */
export const TUTORIAL_MAP_WIDTH = 200;
export const TUTORIAL_MAP_HEIGHT = 128;
/** Attacks on the taught player stop when it is down to this many tiles. */
export const TUTORIAL_MIN_TILES = 40;
/** Spawn phase length in Basics (the player picks a start; tutorialStart or the Start button ends it). */
export const TUTORIAL_SPAWN_SECONDS = 600;

type XY = readonly [number, number];
/** A circle (cx, cy, r) or a rectangle (x0, y0, x1, y1, inclusive) of land to claim. */
type Shape = { c: readonly [number, number, number] } | { r: readonly [number, number, number, number] };
type Site = readonly [BuildingType, number, number, number?];

/** Resources and techs a chapter (or a step) grants. troops = infantry. */
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
  land: Shape[];
  troops: number;
  buildings?: Site[];
  /** awake from the start (still never attacks the taught player unless made hostile) */
  awake?: boolean;
  /** its opinion of the taught player (-100..100) */
  opinion?: number;
}
interface TribeSpec {
  role: string;
  cap: XY;
  troops: number;
  /** land radius (default 4, a normal tribe) */
  r?: number;
}
interface ChapterSpec {
  home: XY;
  /** the taught player's start; absent = picked by the player in a spawn phase (Basics) */
  land?: Shape[];
  troops: { infantry: number; armor?: number; artillery?: number };
  grant: TutorialGrant;
  buildings?: Site[];
  nations: NationSpec[];
  tribes: TribeSpec[];
  /** named tiles for steps and Show me */
  tiles: Record<string, XY>;
  /** chapter terrain on top of the shared map */
  terrain?: (put: (x: number, y: number, t: number) => void) => void;
  doctrinesEarly: boolean;
  /** the player keeps auto research (else the Research panel is theirs to drive) */
  autoResearch: boolean;
}

const HOME: XY = [40, 64];
const HOME_LAND: Shape[] = [{ c: [40, 64, 16] }];
/** A far, frozen nation on the island: there to be a nation, out of the way. */
const FAR_RIVAL: NationSpec = { role: 'rival', cap: [172, 64], land: [{ c: [172, 64, 12] }], troops: 20000 };

function band(put: (x: number, y: number, t: number) => void, x0: number, y0: number, x1: number, y1: number, t: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, t);
}

const SPECS: Record<TutorialChapterId, ChapterSpec> = {
  basics: {
    home: HOME,
    troops: { infantry: 25000 },
    grant: { gold: 1500 },
    nations: [FAR_RIVAL],
    tribes: [
      { role: 'tribe', cap: [58, 64], troops: 4000, r: 6 },
      { role: 'tribeNorth', cap: [40, 44], troops: 4000, r: 6 },
      { role: 'tribeSouth', cap: [40, 84], troops: 4000, r: 6 },
    ],
    tiles: { spawn: HOME, wild: [46, 64], tribe: [58, 64], tribeNorth: [40, 44], tribeSouth: [40, 84], citySite: HOME },
    doctrinesEarly: false,
    autoResearch: true,
  },
  war: {
    home: HOME,
    land: HOME_LAND,
    troops: { infantry: 45000, artillery: 6000 },
    grant: { gold: 6000, iron: 800 },
    nations: [{ role: 'rival', cap: [88, 64], land: [{ r: [57, 36, 104, 92] }], troops: 26000, buildings: [['fort', 64, 64, 2]] }],
    tribes: [{ role: 'tribe', cap: [40, 84], troops: 5000 }],
    tiles: { tribe: [40, 84], rival: [88, 64], front: [57, 64], forest: [62, 48], hills: [62, 80], fort: [64, 64], fortSite: [50, 58], barrageTarget: [64, 64] },
    terrain: (put) => {
      band(put, 58, 36, 69, 61, Terrain.Forest);
      band(put, 58, 67, 69, 92, Terrain.Hills);
    },
    doctrinesEarly: true,
    autoResearch: false,
  },
  economy: {
    home: HOME,
    land: HOME_LAND,
    troops: { infantry: 30000 },
    grant: { gold: 8000, iron: 300, science: 1200 },
    nations: [FAR_RIVAL],
    tribes: [],
    tiles: { iron: [50, 56], mineSite: [50, 56], oil: [50, 72], wellSite: [50, 72], farmSite: [30, 64], marketSite: [30, 52], labSite: [30, 76], citySite: [42, 64] },
    doctrinesEarly: true,
    autoResearch: false,
  },
  navy: {
    home: [114, 64],
    land: [{ r: [98, 48, 131, 80] }],
    troops: { infantry: 40000 },
    grant: { gold: 12000, iron: 1200, oil: 800, techs: ['navigation'] },
    nations: [{ role: 'islander', cap: [172, 64], land: [{ r: [144, 30, 199, 98] }], troops: 20000, buildings: [['port', 144, 56, 1]] }],
    tribes: [],
    tiles: { portSite: [131, 64], coast: [131, 64], sea: [137, 64], enemyPort: [144, 56], enemyCoast: [144, 74], enemy: [172, 64] },
    doctrinesEarly: true,
    autoResearch: false,
  },
  armor: {
    home: HOME,
    land: HOME_LAND,
    troops: { infantry: 30000, armor: 20000 },
    grant: { gold: 12000, iron: 1500, oil: 1500, techs: ['mechanization'] },
    nations: [{ role: 'rival', cap: [92, 64], land: [{ r: [57, 34, 106, 94] }], troops: 8000 }],
    tribes: [],
    // rally far below the factory: the division's info card (to its right) must not cover it
    tiles: { factorySite: [42, 52], rally: [52, 72], front: [57, 64], enemy: [92, 64] },
    doctrinesEarly: true,
    autoResearch: false,
  },
  air: {
    home: HOME,
    land: HOME_LAND,
    troops: { infantry: 40000 },
    grant: { gold: 15000, iron: 1500, oil: 1500, techs: ['flight', 'radar'] },
    nations: [{ role: 'rival', cap: [98, 64], land: [{ r: [57, 30, 110, 98] }], troops: 20000, buildings: [['city', 88, 64, 2]] }],
    tribes: [],
    tiles: { airfieldSite: [46, 58], samSite: [34, 72], enemyCity: [88, 64], dropZone: [76, 46], front: [57, 64], enemy: [98, 64] },
    doctrinesEarly: true,
    autoResearch: false,
  },
  arsenal: {
    home: HOME,
    land: HOME_LAND,
    troops: { infantry: 30000 },
    grant: {
      gold: 30000,
      iron: 2000,
      oil: 1000,
      science: 30000,
      techs: ['agriculture', 'metallurgy', 'logistics', 'fortification', 'ballistics', 'mechanization', 'flight', 'navalMastery'],
    },
    buildings: [
      ['city', 30, 56, 1],
      ['city', 30, 72, 1],
      ['farm', 46, 50, 1],
      ['market', 46, 78, 1],
      ['factory', 52, 64, 1],
    ],
    nations: [FAR_RIVAL],
    tribes: [],
    tiles: { upgradeArea: HOME, factory: [52, 64], city: [30, 56] },
    doctrinesEarly: true,
    autoResearch: false,
  },
  diplomacy: {
    home: HOME,
    land: HOME_LAND,
    troops: { infantry: 40000 },
    grant: { gold: 25000, iron: 1500, oil: 1000, techs: ['nuclearFission'] },
    buildings: [['silo', 34, 64, 1]],
    nations: [
      { role: 'friendA', cap: [82, 30], land: [{ r: [64, 8, 100, 52] }], troops: 25000, awake: true, opinion: 80 },
      { role: 'friendB', cap: [82, 98], land: [{ r: [64, 76, 100, 120] }], troops: 25000, awake: true, opinion: 80 },
      { role: 'leader', cap: [172, 64], land: [{ r: [101, 0, 131, 127] }, { r: [144, 0, 199, 127] }], troops: 90000, buildings: [['city', 172, 64, 3]] },
    ],
    tribes: [],
    tiles: { silo: [34, 64], leader: [172, 64], leaderMainland: [116, 64], friendA: [82, 30], friendB: [82, 98] },
    doctrinesEarly: true,
    autoResearch: false,
  },
};

const SEEDS: Record<TutorialChapterId, number> = { basics: 7101, war: 7102, economy: 7103, navy: 7104, armor: 7105, air: 7106, arsenal: 7107, diplomacy: 7108 };

function spec(ch: TutorialChapterId): ChapterSpec {
  const s = SPECS[ch];
  if (!s) throw new Error(`Unknown tutorial chapter: ${String(ch)}`);
  return s;
}

/** Named tile keys per chapter (tutorialTile); 'home' (the player's capital) works in every chapter. */
export const TUTORIAL_TILE_KEYS: Record<TutorialChapterId, string[]> = Object.fromEntries(
  TUTORIAL_CHAPTER_IDS.map((ch) => [ch, ['home', ...Object.keys(SPECS[ch].tiles).filter((k) => k !== 'home')]]),
) as Record<TutorialChapterId, string[]>;
/** Player roles per chapter (tutorialPlayer). */
export const TUTORIAL_ROLES: Record<TutorialChapterId, string[]> = Object.fromEntries(
  TUTORIAL_CHAPTER_IDS.map((ch) => [ch, [...SPECS[ch].nations.map((n) => n.role), ...SPECS[ch].tribes.map((t) => t.role)]]),
) as Record<TutorialChapterId, string[]>;

// ------------------------------------------------------------------------------------------------ settings and map

/** Settings of a chapter's game: the tutorial map's size class, fixed seed, its AIs and tribes, fast building. */
export function tutorialSettings(ch: TutorialChapterId, player?: { name?: string; color?: [number, number, number] }): GameSettings {
  const s = spec(ch);
  return {
    ...cloneSetup(DEFAULT_SETUP),
    seed: SEEDS[ch],
    map: { kind: 'generated', type: 'continents', size: 'small' },
    aiCount: s.nations.length,
    tribeCount: s.tribes.length,
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

/** The chapter's map (a fresh copy each call: createGame takes ownership of it). */
export function tutorialMap(ch: TutorialChapterId): MapData {
  const s = spec(ch);
  const W = TUTORIAL_MAP_WIDTH;
  const H = TUTORIAL_MAP_HEIGHT;
  const map = createMapData(W, H);
  const put = (x: number, y: number, t: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) map.terrain[y * W + x] = t;
  };
  const blob = (cx: number, cy: number, r: number, f: (i: number) => void): void => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        f(y * W + x);
      }
    }
  };
  map.terrain.fill(Terrain.Plains);
  // The strait: shallow edges, deep middle.
  for (let y = 0; y < H; y++) {
    for (let x = 132; x <= 143; x++) put(x, y, x <= 133 || x >= 142 ? Terrain.ShallowWater : Terrain.DeepWater);
  }
  // Scenery (kept away from every chapter's sites).
  blob(20, 40, 6, (i) => (map.terrain[i] = Terrain.Forest));
  blob(20, 92, 5, (i) => (map.terrain[i] = Terrain.Hills));
  blob(10, 64, 4, (i) => (map.terrain[i] = Terrain.Forest));
  blob(176, 40, 6, (i) => (map.terrain[i] = Terrain.Forest));
  blob(176, 92, 6, (i) => (map.terrain[i] = Terrain.Hills));
  blob(192, 64, 4, (i) => (map.terrain[i] = Terrain.Desert));
  blob(60, 10, 5, (i) => (map.terrain[i] = Terrain.Mountains));
  s.terrain?.(put);
  // Deposits: iron and oil next to the home, fertile land west of it, more on the island.
  blob(50, 56, 1, (i) => (map.resource[i] = Resource.Iron));
  blob(50, 72, 1, (i) => (map.resource[i] = Resource.Oil));
  blob(30, 64, 2, (i) => (map.resource[i] = Resource.Fertile));
  blob(160, 46, 1, (i) => (map.resource[i] = Resource.Iron));
  blob(160, 82, 1, (i) => (map.resource[i] = Resource.Oil));
  for (let i = 0; i < W * H; i++) if (isWater(map.terrain[i])) map.resource[i] = Resource.None;
  computeCoastAndLand(map);
  return map;
}

// ------------------------------------------------------------------------------------------------ setup

const at = (xy: XY): number => xy[1] * TUTORIAL_MAP_WIDTH + xy[0];

function shapeTiles(map: MapData, shapes: Shape[]): number[] {
  const out: number[] = [];
  const w = map.width;
  for (const sh of shapes) {
    if ('c' in sh) {
      const [cx, cy, r] = sh.c;
      forEachInRadius(map, cy * w + cx, r, (i) => {
        if (!isWater(map.terrain[i])) out.push(i);
      });
    } else {
      const [x0, y0, x1, y1] = sh.r;
      for (let y = Math.max(0, y0); y <= Math.min(map.height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) if (!isWater(map.terrain[y * w + x])) out.push(y * w + x);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/** Gives pid the free land in `tiles` and its capital; marks it spawned with these troops. */
function claim(state: GameState, pid: number, tiles: number[], capital: number, troops: { infantry: number; armor?: number; artillery?: number }): void {
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
  p.troops = { infantry: troops.infantry, armor: troops.armor ?? 0, artillery: troops.artillery ?? 0 };
}

function place(state: GameState, pid: number, site: Site): void {
  const [type, x, y, level] = site;
  const t = state.tutorial!;
  const r = applyAdmin(state, t.human, { type: 'admin', op: 'placeBuilding', player: pid, key: type, tile: at([x, y]), amount: level ?? 1 });
  if (!r.ok) throw new Error(`Tutorial: cannot place ${type} at ${x},${y}: ${r.reason}`);
}

/**
 * Sets a chapter up right after createGame(tutorialSettings(ch), tutorialMap(ch)): every AI and tribe at its place
 * (frozen), the player's start (Basics: the player picks it in a long spawn phase), buildings, grants and the
 * tutorial rules (state.tutorial). Every chapter but Basics starts in the 'playing' phase at 0:00.
 */
export function setupTutorial(state: GameState, ch: TutorialChapterId): void {
  const s = spec(ch);
  if (state.map.width !== TUTORIAL_MAP_WIDTH || state.map.height !== TUTORIAL_MAP_HEIGHT) {
    throw new Error('setupTutorial: create the game with createGame(tutorialSettings(ch), tutorialMap(ch)) (or createTutorialGame)');
  }
  const human = state.players.find((p) => p.isHuman)?.id ?? 0;
  if (human <= 0) throw new Error('setupTutorial: no human player');
  const nationIds = s.nations.map((_, k) => human + 1 + k);
  const tribeIds = s.tribes.map((_, k) => human + 1 + s.nations.length + k);
  const frozen: number[] = [];
  s.nations.forEach((n, k) => {
    if (!n.awake) frozen.push(nationIds[k]);
  });
  frozen.push(...tribeIds);
  const tut: TutorialState = {
    chapter: ch,
    human,
    noElimination: true,
    minTiles: TUTORIAL_MIN_TILES,
    home: at(s.home),
    frozen: frozen.sort((a, b) => a - b),
    doctrinesEarly: s.doctrinesEarly,
  };
  state.tutorial = tut;
  // Nobody may attack the player until a step makes an AI hostile (tutorialWake).
  adminState(state).aiPassive = [human];

  // Tribes first, then nations, then the player (each only takes free land, so neighbours share a border).
  s.tribes.forEach((t, k) => {
    const id = tribeIds[k];
    const tiles: number[] = [];
    forEachInRadius(state.map, at(t.cap), t.r ?? 4, (i) => {
      if (!isWater(state.map.terrain[i])) tiles.push(i);
    });
    claim(state, id, tiles.sort((a, b) => a - b), at(t.cap), { infantry: t.troops });
  });
  s.nations.forEach((n, k) => claim(state, nationIds[k], shapeTiles(state.map, n.land), at(n.cap), { infantry: n.troops }));
  state.spawnPoints[human] = at(s.home);
  const p = state.players[human];
  p.auto.research = s.autoResearch;
  if (s.land) {
    claim(state, human, shapeTiles(state.map, s.land), at(s.home), s.troops);
    // Straight into play at 0:00.
    state.phase = 'playing';
    state.spawnLeft = 0;
    state.playStartTick = state.tick;
  } else {
    // Basics: the player picks the start in a spawn phase that waits for them.
    state.spawnLeft = TUTORIAL_SPAWN_SECONDS;
  }
  s.nations.forEach((n, k) => {
    if (n.opinion !== undefined) state.opinion[nationIds[k]][human] = n.opinion;
  });
  tutorialGrant(state, human, s.grant);
  if (state.phase === 'playing') {
    for (const b of s.buildings ?? []) place(state, human, b);
    s.nations.forEach((n, k) => {
      for (const b of n.buildings ?? []) place(state, nationIds[k], b);
    });
  }
}

/** createGame + setupTutorial for a chapter: the whole game, ready to tick. */
export function createTutorialGame(ch: TutorialChapterId, player?: { name?: string; color?: [number, number, number] }): GameState {
  const state = createGame(tutorialSettings(ch, player), tutorialMap(ch));
  setupTutorial(state, ch);
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

/** Makes an AI attack the taught player now across their shared border with 40% of its troops (a "defend" step). */
export function tutorialEnemyAttack(state: GameState, aiId: number): boolean {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing') return false;
  return applyAdmin(state, t.human, { type: 'admin', op: 'declareWar', player: aiId, other: t.human }).ok;
}

/** Finishes the player's constructions, upgrades, research and queued warships / tank divisions now. */
export function tutorialFinish(state: GameState, pid: number): void {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing') return;
  applyAdmin(state, t.human, { type: 'admin', op: 'finishConstructions', player: pid });
  if (state.players[pid]?.researching) applyAdmin(state, t.human, { type: 'admin', op: 'finishResearch', player: pid });
  for (const q of unitQueue(state)) if (q.owner === pid && q.readyTick > state.tick) q.readyTick = state.tick;
  // silos reloaded (the atom bomb step follows a rocket)
  for (const b of state.buildings.values()) if (b.owner === pid && b.type === 'silo') b.cooldown = 0;
}

/** Basics: ends the spawn phase on the next tick once the player has picked a start (like the Start button). */
export function tutorialStart(state: GameState): boolean {
  const t = state.tutorial;
  if (!t || state.phase !== 'spawn' || !state.players[t.human]?.spawned) return false;
  state.spawnLeft = Math.min(state.spawnLeft, 1e-6);
  return true;
}

/** A named tile of the chapter (TUTORIAL_TILE_KEYS), or -1. 'home' is the player's capital (or its planned start). */
export function tutorialTile(state: GameState, ch: TutorialChapterId, key: string): number {
  const s = SPECS[ch];
  if (!s) return -1;
  if (key === 'home' || (ch === 'basics' && key === 'citySite')) {
    const p = state.tutorial ? state.players[state.tutorial.human] : undefined;
    return p && p.alive && p.capital >= 0 ? p.capital : at(s.home);
  }
  if (ch === 'basics' && key === 'wild') {
    const w = borderWild(state);
    if (w >= 0) return w;
  }
  // the front moves as land changes hands: the rival's tile at the player's border nearest the planned one
  if (key === 'front' && Object.prototype.hasOwnProperty.call(s.tiles, 'front')) {
    const f = borderEnemy(state, tutorialPlayer(state, ch, 'rival'), s.tiles.front[1]);
    if (f >= 0) return f;
  }
  const xy = Object.prototype.hasOwnProperty.call(s.tiles, key) ? s.tiles[key] : undefined;
  return xy ? at(xy) : -1;
}

/** Basics: free land right at the player's border, nearest the capital (east first), or -1 before the spawn. */
function borderWild(state: GameState): number {
  const t = state.tutorial;
  const p = t ? state.players[t.human] : undefined;
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
      const bx = x - Math.sign(dx);
      const by = y - Math.sign(dy);
      if (map.owner[by * w + bx] === t!.human) return i;
    }
  }
  return -1;
}

/** The first tile of `enemy` east of the player's land, on the row nearest `row` that has one, or -1. */
function borderEnemy(state: GameState, enemy: number, row: number): number {
  const t = state.tutorial;
  if (!t || enemy <= 0) return -1;
  const map = state.map;
  const w = map.width;
  for (let d = 0; d <= 24; d++) {
    for (const y of d === 0 ? [row] : [row - d, row + d]) {
      if (y < 0 || y >= map.height) continue;
      for (let x = 1; x < w; x++) {
        const i = y * w + x;
        if (map.owner[i] === enemy && map.owner[i - 1] === t.human) return i;
      }
    }
  }
  return -1;
}

/** Player id of a chapter role (TUTORIAL_ROLES: 'rival', 'islander', 'leader', 'friendA', 'tribe', ...), or 0. */
export function tutorialPlayer(state: GameState, ch: TutorialChapterId, role: string): number {
  const s = SPECS[ch];
  const human = state.tutorial?.human ?? 1;
  if (!s) return 0;
  if (role === 'me' || role === 'human') return human;
  const n = s.nations.findIndex((x) => x.role === role);
  if (n >= 0) return human + 1 + n;
  const k = s.tribes.findIndex((x) => x.role === role);
  return k >= 0 ? human + 1 + s.nations.length + k : 0;
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
