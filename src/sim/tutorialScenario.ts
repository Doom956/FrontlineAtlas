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
// Chapters (navy, air, armor, defense, diplomacy, supply, seasons) use the same map and rules with a ChapterSpec each:
// the player is placed and the game starts at once, with the resources and techs the lesson needs, the other nations
// and buildings it uses, and nothing else (no rule changes: only the setup hooks the owner console already has).
// Deterministic: fixed seed, no Math.random / Date.
import { adminState, applyAdmin } from './admin';
import { TECHS } from './config';
import { forEachInRadius } from './grid';
import { computeCoastAndLand, createMapData } from './mapgen';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP } from './setup';
import { updateFog } from './fog';
import { SEASON_TICKS } from './seasons';
import { createGame, setOwner, spawnPlayer } from './state';
import { isTribe, isWater, Terrain } from './types';
import type { BuildingType, GameSettings, GameState, MapData, TechId, TutorialChapterId, TutorialState } from './types';
import { unitQueue } from './navy';
import { answerAlliance } from './diplomacy';
import { damageHub } from './supplylines';
import { moveTankDivisions } from './tanks';
import { answerTreaty, offerPeace } from './treaty';

export type { TutorialChapterId } from './types';

type XY = readonly [number, number];

/** The tutorial's id (TutorialState.chapter). There is one tutorial; 'basics' also marks it done in saved progress. */
export const TUTORIAL_ID: TutorialChapterId = 'basics';
/** The tutorial map: mainland x 0..131, then sea with one island (centre ISLAND_C, radii ISLAND_R) in it. */
export const TUTORIAL_MAP_WIDTH = 200;
const ISLAND_C: XY = [166, 64];
const ISLAND_R: XY = [15, 21];
export const TUTORIAL_MAP_HEIGHT = 128;
/** Attacks on the taught player stop when it is down to this many tiles. */
export const TUTORIAL_MIN_TILES = 40;
/** Spawn phase length (the player picks a start; tutorialStart or the Start button ends it). */
export const TUTORIAL_SPAWN_SECONDS = 600;

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
/** The navy chapter's island nation: its army (kept at this while the player lands; tutorialWeaken). */
export const ISLANDERS = 2500;

/** A building the scenario places (before the first tick); `owner` is a role, 'me' = the player. */
interface Placed {
  type: BuildingType;
  at: XY;
  owner: string;
  level?: number;
  /** bombers / fighters in it (an airfield) */
  bombers?: number;
}

/** One lesson's setup. */
interface ChapterSpec {
  /** the player's start (the suggested start in the basics) */
  home: XY;
  /** more land for the player around its start (a rectangle, inclusive) */
  land?: readonly [number, number, number, number];
  /** the player is placed and the game starts at once (chapters); the basics let the player pick the start */
  pre: boolean;
  grant: TutorialGrant;
  nations: NationSpec[];
  tribes: TribeSpec[];
  /** named tiles for steps and Show me ('home', 'wild' and 'front' follow the game, see tutorialTile) */
  tiles: Record<string, XY>;
  buildings?: Placed[];
  /** roles that decide again from the start (diplomacy: they answer offers) */
  awake?: string[];
  /** [role, opinion of the player -100..100] */
  opinions?: [string, number][];
  /** roles that attack the player at the start (a war to make peace in) */
  attackers?: string[];
  /** techs a nation starts with (role, techs) */
  techs?: [string, TechId[]][];
}

const SPECS: Record<string, ChapterSpec> = {
  basics: {
    home: HOME,
    pre: false,
    grant: { gold: 1500 },
    // weak and frozen: the "attack a neighbour" step
    nations: [{ role: 'rival', cap: [76, 78], land: [56, 58, 96, 98], troops: 3000 }],
    // its capital stays well clear of the no-spawn radius around it (state.ts spawnMinDistance) at the suggested start
    // straight north of the suggested start
    tribes: [{ role: 'tribe', cap: [42, 44], troops: 4000, r: 8 }],
    tiles: { spawn: HOME, citySite: HOME, wild: [46, 64], tribe: [42, 44], rival: [76, 78], front: [56, 66] },
  },
  // across open water: a Port, a warship, a transport, and an island with a weak nation and its City to take
  navy: {
    home: [126, 64],
    pre: true,
    grant: { gold: 4000, iron: 200, oil: 200, troops: 15000, techs: ['navigation'] },
    // the City on the far shore: a landing takes a beachhead, more clicks take the rest
    nations: [{ role: 'islanders', cap: [170, 72], land: [148, 40, 184, 88], troops: ISLANDERS }],
    tribes: [],
    tiles: { coast: [131, 64], island: [151, 64], islandCity: [177, 62] },
    buildings: [{ type: 'city', at: [177, 62], owner: 'islanders' }],
  },
  // a weak nation with a Fort and a SAM site 20 to 30 tiles away: Airfield, bombers, bombs
  air: {
    home: HOME,
    pre: true,
    grant: { gold: 5000, iron: 300, oil: 300, techs: ['flight'] },
    nations: [{ role: 'foe', cap: [90, 64], land: [60, 52, 100, 76], troops: 2000 }],
    tribes: [],
    tiles: { fort: [66, 64], sam: [68, 58], foe: [90, 64] },
    buildings: [
      { type: 'fort', at: [66, 64], owner: 'foe' },
      { type: 'sam', at: [68, 58], owner: 'foe' },
    ],
  },
  // a weak front right next door: Mechanization, a Factory, a tank division
  armor: {
    home: HOME,
    pre: true,
    grant: { gold: 4000, iron: 900, oil: 300, armor: 5000, techs: ['metallurgy'] },
    nations: [{ role: 'foe', cap: [76, 64], land: [46, 50, 90, 78], troops: 1200 }],
    tribes: [],
    tiles: { front: [46, 64], push: [56, 64] },
  },
  // a strong neighbour along a long border: Fortification, a Fort at the border, Tank Traps. A Fort stops a spearhead
  // inside its own reach, the traps work in the belt beyond it, so the enemy tanks come at the border well north of
  // the Fort ('tanks', inside the belt).
  defense: {
    home: HOME,
    pre: true,
    grant: { gold: 3000, iron: 200, science: 2500, techs: ['fortification'] },
    land: [30, 12, 60, 116],
    nations: [{ role: 'foe', cap: [90, 64], land: [61, 12, 110, 116], troops: 30000 }],
    tribes: [],
    tiles: { front: [61, 64], fort: [58, 64], tanks: [58, 28] },
  },
  // three neighbours: one friendly, one at war with you and weak, one quiet
  diplomacy: {
    home: HOME,
    pre: true,
    grant: { gold: 1000 },
    nations: [
      { role: 'friend', cap: [40, 30], land: [30, 22, 52, 40], troops: 6000 },
      { role: 'enemy', cap: [76, 64], land: [46, 52, 92, 76], troops: 3000 },
      { role: 'quiet', cap: [40, 100], land: [30, 88, 52, 106], troops: 6000 },
    ],
    tribes: [],
    tiles: { friend: [40, 30], enemy: [76, 64], quiet: [40, 100] },
    // all three stay frozen: the chapter's steps answer the player's offers (tutorialAccept) and keep the war going
    opinions: [['friend', 80]],
    attackers: ['enemy'],
  },
  // an enemy city on the only rail to its front fort: bomb it and the fort is cut off
  supply: {
    home: HOME,
    pre: true,
    grant: { gold: 3000, iron: 300, techs: ['flight'] },
    nations: [{ role: 'foe', cap: [100, 64], land: [49, 52, 112, 76], troops: 2000 }],
    tribes: [],
    // the City sits off the middle of the enemy's land, clear of its name on the map
    tiles: { airfield: [44, 64], city: [74, 57], fort: [54, 64], foe: [100, 64] },
    // Flak on the foe's Fort and City wears the bombers, so a bomb mostly damages the hub instead of razing it
    techs: [['foe', ['flakGuns']]],
    buildings: [
      { type: 'airfield', at: [44, 64], owner: 'me', bombers: 4 },
      { type: 'fort', at: [54, 64], owner: 'foe' },
      { type: 'city', at: [74, 57], owner: 'foe' },
    ],
  },
  // a weak neighbour to attack once the seasons have been shown
  seasons: {
    home: HOME,
    pre: true,
    grant: { gold: 1000, techs: ['mechanization'] },
    nations: [{ role: 'foe', cap: [76, 64], land: [46, 52, 90, 76], troops: 1500 }],
    tribes: [],
    // snow: where the winter snow line shows (it comes down from the poles)
    tiles: { front: [46, 64], snow: [40, 32] },
  },
};
const SEED = 7101;

/** The chapters that can be played (the basics first). */
export const TUTORIAL_CHAPTER_IDS: TutorialChapterId[] = ['basics', 'navy', 'air', 'armor', 'defense', 'diplomacy', 'supply', 'seasons'];

function specOf(chapter: string | undefined): ChapterSpec {
  return SPECS[chapter ?? TUTORIAL_ID] ?? SPECS[TUTORIAL_ID];
}
const SPEC = SPECS[TUTORIAL_ID];

/** Named tile keys of the basics (tutorialTile); 'home' is the player's capital. */
export const TUTORIAL_TILE_KEYS: string[] = ['home', ...Object.keys(SPEC.tiles)];
/** Player roles of the basics (tutorialPlayer). */
export const TUTORIAL_ROLES: string[] = [...SPEC.nations.map((n) => n.role), ...SPEC.tribes.map((t) => t.role)];
/** Named tile keys and player roles of a chapter. */
export const chapterTileKeys = (chapter: TutorialChapterId): string[] => ['home', ...Object.keys(specOf(chapter).tiles)];
export const chapterRoles = (chapter: TutorialChapterId): string[] => [...specOf(chapter).nations.map((n) => n.role), ...specOf(chapter).tribes.map((t) => t.role)];

// ------------------------------------------------------------------------------------------------ settings and map

/** Settings of the tutorial game: the tutorial map's size class, a fixed seed, its AI and tribe, fast building. */
export function tutorialSettings(player?: { name?: string; color?: [number, number, number] }, chapter: TutorialChapterId = TUTORIAL_ID): GameSettings {
  const SPEC = specOf(chapter);
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
  // The sea east of the mainland (x >= 132), shallow along the coasts, with one island out in it (the navy chapter):
  // an oval of land about 18 tiles off the coast, open water all round it.
  for (let y = 0; y < H; y++) {
    for (let x = 132; x < W; x++) {
      const d = ((x - ISLAND_C[0]) / ISLAND_R[0]) ** 2 + ((y - ISLAND_C[1]) / ISLAND_R[1]) ** 2;
      put(x, y, d <= 1 ? Terrain.Plains : d <= 1.35 || x <= 133 ? Terrain.ShallowWater : Terrain.DeepWater);
    }
  }
  // Scenery, away from the start, the tribe and the neighbour.
  blob(20, 40, 6, Terrain.Forest);
  blob(20, 92, 5, Terrain.Hills);
  blob(10, 64, 4, Terrain.Forest);
  blob(172, 54, 4, Terrain.Forest);
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
export function setupTutorial(state: GameState, chapter: TutorialChapterId = TUTORIAL_ID): void {
  const SPEC = specOf(chapter);
  if (state.map.width !== TUTORIAL_MAP_WIDTH || state.map.height !== TUTORIAL_MAP_HEIGHT) {
    throw new Error('setupTutorial: create the game with createGame(tutorialSettings(), tutorialMap()) (or createTutorialGame)');
  }
  const human = state.players.find((p) => p.isHuman)?.id ?? 0;
  if (human <= 0) throw new Error('setupTutorial: no human player');
  const nationIds = SPEC.nations.map((_, k) => human + 1 + k);
  const tribeIds = SPEC.tribes.map((_, k) => human + 1 + SPEC.nations.length + k);
  const tut: TutorialState = {
    chapter,
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
  if (SPEC.pre) startChapter(state, SPEC, human, nationIds, tribeIds);
  tutorialGrant(state, human, SPEC.grant); // after the start: placing the player sets its army
}

/** A chapter's start: the player stands at home, the game is running, the lesson's buildings and moods are set. */
function startChapter(state: GameState, SPEC: ChapterSpec, human: number, nationIds: number[], tribeIds: number[]): void {
  if (!spawnPlayer(state, human, at(SPEC.home))) throw new Error('setupTutorial: the start is not valid');
  // the spawn phase ends here, as sim.tick would end it
  state.spawnLeft = 0;
  state.phase = 'playing';
  state.playStartTick = state.tick;
  if (SPEC.land) {
    const [x0, y0, x1, y1] = SPEC.land;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (state.map.owner[at([x, y])] === 0 && !isWater(state.map.terrain[at([x, y])])) setOwner(state, at([x, y]), human);
  }
  updateFog(state, true);
  const idOf = (role: string): number => (role === 'me' ? human : tutorialRoleId(SPEC, human, nationIds, tribeIds, role));
  for (const b of SPEC.buildings ?? []) {
    tutorialPlace(state, idOf(b.owner), b.type, at(b.at), b.level ?? 1, b.bombers ?? 0);
  }
  for (const [role, o] of SPEC.opinions ?? []) {
    const pid = idOf(role);
    if (pid > 0) state.opinion[pid][human] = o;
  }
  for (const [role, techs] of SPEC.techs ?? []) {
    const pid = idOf(role);
    if (pid > 0) tutorialGrant(state, pid, { techs });
  }
  const awake = (SPEC.awake ?? []).map(idOf).filter((x) => x > 0);
  if (awake.length) state.tutorial!.frozen = state.tutorial!.frozen.filter((id) => !awake.includes(id));
  for (const role of SPEC.attackers ?? []) {
    const pid = idOf(role);
    if (pid > 0) applyAdmin(state, human, { type: 'admin', op: 'declareWar', player: pid, other: human });
  }
}

/** Puts a finished building of `owner` on a tile (a lesson's target, or a rebuilt one); `bombers` fills an airfield. */
export function tutorialPlace(state: GameState, owner: number, type: BuildingType, tile: number, level = 1, bombers = 0): boolean {
  const t = state.tutorial;
  if (!t || owner <= 0 || state.phase !== 'playing') return false;
  const r = applyAdmin(state, t.human, { type: 'admin', op: 'placeBuilding', player: owner, tile, key: type, amount: level });
  if (r.ok && bombers > 0) applyAdmin(state, t.human, { type: 'admin', op: 'giveAircraft', player: owner, tile, key: 'bomber', amount: bombers });
  return r.ok;
}

function tutorialRoleId(SPEC: ChapterSpec, human: number, nationIds: number[], tribeIds: number[], role: string): number {
  const n = SPEC.nations.findIndex((x) => x.role === role);
  if (n >= 0) return nationIds[n];
  const k = SPEC.tribes.findIndex((x) => x.role === role);
  return k >= 0 ? tribeIds[k] : 0;
}

/** createGame + setupTutorial: the whole game, ready to tick. */
export function createTutorialGame(player?: { name?: string; color?: [number, number, number] }, chapter: TutorialChapterId = TUTORIAL_ID): GameState {
  const state = createGame(tutorialSettings(player, chapter), tutorialMap());
  setupTutorial(state, chapter);
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

/**
 * A frozen AI answers the taught player now: it accepts the player's alliance request and peace or pact offer to it
 * (the diplomacy chapter's AIs stay frozen, so this is the only way they answer). True if something was signed.
 */
export function tutorialAccept(state: GameState, aiId: number): boolean {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing' || aiId === t.human || !state.players[aiId]?.alive) return false;
  let signed = false;
  if (state.allianceRequests.some((r) => r.from === t.human && r.to === aiId)) signed = answerAlliance(state, aiId, t.human, true).ok || signed;
  if ((state.treatyOffers ?? []).some((o) => o.from === t.human && o.to === aiId)) signed = answerTreaty(state, aiId, t.human, true).ok || signed;
  return signed;
}

/**
 * An AI offers the taught player plain peace (nobody pays) now, after clearing any wait a refusal left between the two.
 * False when an offer between them is already waiting or peace is not possible (no fighting in the last minute).
 */
export function tutorialOfferPeace(state: GameState, aiId: number): boolean {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing' || aiId === t.human) return false;
  const c = state.treatyCooldowns;
  if (c?.length) {
    const keep: number[] = [];
    for (let k = 0; k < c.length; k += 3) {
      const pair = (c[k] === aiId && c[k + 1] === t.human) || (c[k] === t.human && c[k + 1] === aiId);
      if (!pair) keep.push(c[k], c[k + 1], c[k + 2]);
    }
    state.treatyCooldowns = keep;
  }
  return offerPeace(state, aiId, t.human, 'none', 'none').ok;
}

/**
 * An AI sends a tank division at the taught player's tile `target` (the defense chapter: its traps get to work). The
 * division appears on the AI's land nearest the target and drives in as a spearhead. False if it can't.
 */
export function tutorialEnemyTanks(state: GameState, aiId: number, target: number): boolean {
  const t = state.tutorial;
  if (!t || state.phase !== 'playing' || aiId === t.human || target < 0) return false;
  const map = state.map;
  const w = map.width;
  const tx = target % w;
  const ty = (target / w) | 0;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < map.owner.length; i++) {
    if (map.owner[i] !== aiId || isWater(map.terrain[i]) || map.building[i]) continue;
    const d = ((i % w) - tx) ** 2 + (((i / w) | 0) - ty) ** 2;
    // a few tiles back from the border, so the division drives up and charges
    if (d >= 36 && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return false;
  if (!applyAdmin(state, t.human, { type: 'admin', op: 'spawnTankDivision', player: aiId, tile: best }).ok) return false;
  const unit = state.units.filter((u) => u.owner === aiId && u.type === 'tankDivision' && u.hp > 0).sort((a, b) => b.id - a.id)[0];
  return !!unit && moveTankDivisions(state, aiId, [unit.id], target).ok;
}

/**
 * Damages a nation's supply hub on `tile` as a bomb by `by` would (the supply chapter: a City the bombs razed is put
 * back damaged, so the cut it would have made still stands). False if it is no hub or is guarded.
 */
export function tutorialHitHub(state: GameState, owner: number, tile: number, by: number): boolean {
  if (!state.tutorial || state.phase !== 'playing') return false;
  return damageHub(state, owner, tile, by);
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
 * Jumps the game clock to the start of a season (0 spring .. 3 winter), so the seasons chapter can show all four in
 * seconds. The season is a pure function of the play clock (seasons.ts), so only playStartTick moves (it is hashed).
 */
export function tutorialSetSeason(state: GameState, index: number, into = 0): void {
  if (!state.tutorial || state.phase !== 'playing') return;
  const i = Math.max(0, Math.min(3, Math.round(index)));
  // `into`: how far into the season (0..0.9 of it), e.g. far enough into winter that the snow has come
  const f = Math.max(0, Math.min(0.9, Number.isFinite(into) ? into : 0));
  state.playStartTick = state.tick - i * SEASON_TICKS - Math.floor(f * SEASON_TICKS) - 5;
}

/**
 * A named tile (TUTORIAL_TILE_KEYS), or -1. 'home' and 'citySite' are the player's capital (or the suggested start),
 * 'wild' free land at the player's border, 'front' the neighbour's land at the player's border.
 */
export function tutorialTile(state: GameState, key: string): number {
  if (!state.tutorial) return -1;
  const SPEC = specOf(state.tutorial.chapter);
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
  const SPEC = specOf(state.tutorial?.chapter);
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
