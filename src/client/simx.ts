// Client helpers around newer sim features: build targets (resolveBuildTarget), building levels, public army sizes,
// advisor suggestions, paratroopers and artillery barrages. The HUD, input and renderer go through these, so the
// rules live in the sim and the client only phrases them.
import { suggestions, type Suggestion as SimSuggestion } from '../sim/advisor';
import { canBarrage, barrageRange, barrageReadyIn, artilleryOf } from '../sim/barrage';
import { armyTotalOf, buildingAt, buildingCost, buildingMaxLevel, buildingsOf, resolveBuildTarget } from '../sim/buildings';
import { BARRAGE_MIN_ARTILLERY, BARRAGE_RADIUS, BUILDINGS, PARADROP_MIN_TROOPS } from '../sim/config';
import { hasTech } from '../sim/tech';
import { canParadrop, paradropMaxTroops, paradropRange } from '../sim/units';
import type { Action, Building, BuildingType, GameState, Player } from '../sim/types';
import type { UiState } from './uiState';

// ------------------------------------------------------------------------------------------------ build targets

export interface BuildTarget {
  /** the order is possible right now (place or upgrade, and affordable) */
  ok: boolean;
  /** tile the building goes on (or the building upgraded); -1 when nothing fits near the cursor */
  tile: number;
  upgrade: boolean;
  /** level after building (1 for a new building) */
  level: number;
  cost: { gold: number; iron: number };
  /** why not, when !ok */
  error: string;
}

/** What a build click on `tile` would do (sim resolveBuildTarget). */
export function resolveBuild(state: GameState, playerId: number, type: BuildingType, tile: number): BuildTarget {
  const r = resolveBuildTarget(state, playerId, type, tile);
  if ('error' in r) return { ok: false, tile: -1, upgrade: false, level: 1, cost: buildingCost(state, playerId, type), error: r.error };
  return { ok: r.affordable, tile: r.tile, upgrade: r.upgrade, level: r.level, cost: r.cost, error: r.affordable ? '' : r.reason ?? 'Not enough money' };
}

/** Per-viewer cache so the ghost does not resolve every frame (keyed by type, tile, a few ticks and buildings). */
export class BuildTargetCache {
  private key = '';
  private value: BuildTarget | null = null;
  get(state: GameState, playerId: number, type: BuildingType, tile: number): BuildTarget {
    const key = `${type}|${tile}|${Math.floor(state.tick / 3)}|${state.buildingsVersion}`;
    if (key !== this.key || !this.value) {
      this.key = key;
      this.value = resolveBuild(state, playerId, type, tile);
    }
    return this.value;
  }
}

/** Highest level of a building type. */
export function maxLevel(type: BuildingType): number {
  return buildingMaxLevel(type);
}

// ------------------------------------------------------------------------------------------------ armies

/** A player's whole army as everyone sees it (public: home, attacks, transports, cargo planes). */
export function armyOf(state: GameState, id: number): number {
  return armyTotalOf(state, id);
}
/** Same as armyOf (kept for readability where "the whole army" is meant). */
export function fieldArmy(state: GameState, id: number): number {
  return armyTotalOf(state, id);
}

// ------------------------------------------------------------------------------------------------ advisor

export interface Suggestion {
  key: string;
  text: string;
  /** a building to build (the strip's button enters build mode) */
  building?: BuildingType;
  /** a map point to centre on */
  tile?: number;
  /** a drawer to open */
  drawer?: 'army' | 'forces' | 'research' | 'diplomacy';
  /** a unit to buy (the button builds one at the best port / airfield) */
  unit?: 'warship' | 'bomber' | 'fighter';
  /** a target mode to enter */
  mode?: 'barrage' | 'paradrop';
}

/** The sim's suggestions() (advisor.ts, most urgent first) mapped to what the advisor strip's button does. */
export function adviceFor(state: GameState, playerId: number): Suggestion[] {
  const raw: SimSuggestion[] = suggestions(state, playerId);
  return raw.map((r) => {
    const s: Suggestion = { key: r.id, text: r.text };
    if (r.building && r.building in BUILDINGS) s.building = r.building;
    if (typeof r.tile === 'number' && r.tile >= 0) s.tile = r.tile;
    if (/^research|tech/.test(r.id)) s.drawer = 'research';
    else if (/^mix|army/.test(r.id) && !s.building) s.drawer = 'army';
    else if (/^answer|alliance|ally|diplom/.test(r.id)) s.drawer = 'diplomacy';
    else if (r.id.startsWith('barrage')) s.mode = 'barrage';
    else if (r.id.startsWith('paradrop')) s.mode = 'paradrop';
    return s;
  });
}

// ------------------------------------------------------------------------------------------------ paratroopers

export { paradropRange, paradropMaxTroops, barrageRange, PARADROP_MIN_TROOPS, BARRAGE_RADIUS };

/** Paratroopers a drop sends: the attack share of your infantry, capped by the airfield. */
export function paradropTroops(state: GameState, me: Player, ui: UiState, airfield: Building | undefined): number {
  const want = Math.floor(me.troops.infantry * Math.max(0, Math.min(1, ui.attackShare)));
  if (!airfield) return want;
  return Math.max(Math.min(want, paradropMaxTroops(state, me.id, airfield)), Math.min(PARADROP_MIN_TROOPS, Math.floor(me.troops.infantry)));
}

function dist2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

/** Your finished airfields, nearest to `tile` first. */
export function airfieldsNear(state: GameState, playerId: number, tile: number): Building[] {
  const w = state.map.width;
  return buildingsOf(state, playerId, 'airfield')
    .filter((b) => b.buildLeft <= 0)
    .sort((a, b) => dist2(w, a.tile, tile) - dist2(w, b.tile, tile));
}

export interface DropPlan {
  /** '' when possible */
  reason: string;
  /** airfield tile to fly from (-1 none) */
  airfield: number;
  troops: number;
}

/**
 * A paratrooper drop on `tile`: from `airfield` if given, else the nearest airfield that can do it now (else the
 * nearest one, with its reason). Uses the sim's canParadrop.
 */
export function planParadrop(state: GameState, me: Player, ui: UiState, tile: number, airfield = -1): DropPlan {
  if (!hasTech(me, 'flight')) return { reason: 'Research Flight first', airfield: -1, troops: 0 };
  const fields = airfield >= 0 ? [buildingAt(state, airfield)].filter((b): b is Building => !!b) : airfieldsNear(state, me.id, tile);
  if (!fields.length) return { reason: 'Build an Airfield first', airfield: -1, troops: 0 };
  let first: DropPlan | null = null;
  for (const b of fields) {
    const troops = paradropTroops(state, me, ui, b);
    const r = canParadrop(state, me.id, b.tile, tile, troops);
    if (r.ok) return { reason: '', airfield: b.tile, troops };
    first ??= { reason: r.reason ?? 'Not possible', airfield: b.tile, troops };
  }
  return first!;
}

export function paradropAction(plan: DropPlan, tile: number): Action {
  return { type: 'paradrop', airfield: plan.airfield, tile, troops: plan.troops };
}

/** Seconds until the soonest of your airfields can drop again (0 = one is ready, -1 = none). */
export function paradropReadyIn(state: GameState, playerId: number): number {
  const fields = buildingsOf(state, playerId, 'airfield').filter((b) => b.buildLeft <= 0);
  if (!fields.length) return -1;
  return Math.max(0, Math.min(...fields.map((b) => b.dropCooldown)));
}

// ------------------------------------------------------------------------------------------------ barrage

/** Why a barrage on `tile` is not possible now ('' = possible); the sim's canBarrage. */
export function barrageCheck(state: GameState, playerId: number, tile: number): string {
  const r = canBarrage(state, playerId, tile);
  return r.ok ? '' : r.reason ?? 'Not possible';
}
/** Why no barrage at all right now ('' = ready): reload or too little artillery. */
export function barrageStatus(state: GameState, playerId: number): string {
  const left = barrageReadyIn(state, playerId);
  if (artilleryOf(state, playerId) < BARRAGE_MIN_ARTILLERY) return `Needs ${BARRAGE_MIN_ARTILLERY} artillery: build an Arsenal and add artillery to the mix`;
  if (left > 0) return `Guns reloading: ${Math.ceil(left)} s`;
  return '';
}
export function barrageAction(tile: number): Action {
  return { type: 'barrage', tile };
}
export { barrageReadyIn };
