// The pillars on the client: warship stances, tank division modes and air-wing missions, phrased for the orders bar
// (hud/ordersBar.ts), the airfield panel (hud/airPanel.ts), the Forces drawer and the map overlay
// (render/pillarOverlay.ts). The rules stay in the sim (naval2.ts, armor2.ts, airwings.ts); this file reads the state,
// builds the actions (setUnitStance, setDivisionMode, setAirMission) and says what a unit is doing in one line.
//
// Map picks: a stance or mission that needs a place enters the 'pillarPick' target mode (uiState.ts). The stance or
// mode is set at once; the click only aims it:
//   bombard   click an enemy coast (or water off it): the ships sail there and shell the nearest enemy coast
//   blockade  click an enemy port: the ships sail off it and blockade the nearest enemy port
//   front     click a front (a tile at or near your border): divisions hold behind it and spearhead into weak spots
//   air       support: click an attack / front; strategic: click a tile of the nation to raid; superiority: click
//             the centre of the patrol (own land or right at the front)
import { buildingAt, buildingsOf } from '../sim/buildings';
import { ARMOR_POCKET_MAX_TILES, ARMOR_VET_XP, MAX_GROUP_UNITS, NAVY_BLOCKADE_RANGE, NAVY_SUPPORT_RANGE, NAVY_VET_XP, TANK_SPEARHEAD_WIDTH, TICKS_PER_SECOND, UNITS } from '../sim/config';
import { areAllied } from '../sim/diplomacy';
import { sameWater } from '../sim/grid';
import { divisionMode, divisionStrength } from '../sim/armor2';
import { AIR_MISSION_INFO, airMissionOf, airPatrolRadius, airRaidOn, airSupportRadius, airWingCap, airWingRange, airWingSize, wingOf } from '../sim/airwings';
import { atWar, blockadedPorts, portBlockadedBy, warshipStance } from '../sim/naval2';
import { hasTech } from '../sim/tech';
import type { SpearheadPreview } from '../sim/tanks';
import { isWater } from '../sim/types';
import type { Action, AirMission, Building, DivisionMode, GameState, Player, Unit, WarshipStance } from '../sim/types';
import type { Dispatch, UiState } from './uiState';

export type PillarPick = 'bombard' | 'blockade' | 'front' | 'airSupport' | 'airStrategic' | 'airSuperiority';

// ------------------------------------------------------------------------------------------------ texts

export interface ChoiceInfo {
  name: string;
  icon: string;
  /** one line: what it does */
  help: string;
  /** the map pick it asks for after it is set (optional click) */
  pick?: PillarPick;
}

export const STANCE_INFO: Record<WarshipStance, ChoiceInfo> = {
  auto: { name: 'Auto', icon: 'shield', help: 'Guards its post: sinks enemy ships nearby and shells enemy coast near your fronts while at war.' },
  hunt: { name: 'Hunt', icon: 'target', help: 'Chases enemy ships over a wide area.' },
  escort: { name: 'Escort', icon: 'transport', help: 'Sticks to your transports and trade ships: escorted ships are much harder to sink.' },
  bombard: { name: 'Bombard', icon: 'barrage', help: `Parks off an enemy coast: land within ${NAVY_SUPPORT_RANGE} tiles is cheaper and faster to take and loses defenders.`, pick: 'bombard' },
  blockade: { name: 'Blockade', icon: 'embargo', help: `Parks off an enemy port (within ${NAVY_BLOCKADE_RANGE} tiles): it loses trade, its region's supply drops, its trade ships are captured.`, pick: 'blockade' },
};
export const STANCE_ORDER: readonly WarshipStance[] = ['auto', 'hunt', 'escort', 'bombard', 'blockade'];

export const MODE_INFO: Record<DivisionMode, ChoiceInfo> = {
  hold: { name: 'Hold', icon: 'stop', help: 'Stays where it is and defends the land around it; refits slowly in place.' },
  support: { name: 'Support front', icon: 'attack', help: 'Holds behind a front you pick and spearheads into its weak spots by itself when ready.', pick: 'front' },
  refit: { name: 'Refit', icon: 'upgrade', help: 'Drives to your nearest Factory and refills its tanks there, then holds.' },
};
export const MODE_ORDER: readonly DivisionMode[] = ['hold', 'support', 'refit'];

const AIR_ICON: Record<AirMission, string> = { idle: 'pause', support: 'attack', strategic: 'bomb', superiority: 'plane' };
const AIR_PICK: Partial<Record<AirMission, PillarPick>> = { support: 'airSupport', strategic: 'airStrategic', superiority: 'airSuperiority' };
export const AIR_ORDER: readonly AirMission[] = ['support', 'strategic', 'superiority', 'idle'];
export function airInfo(m: AirMission): ChoiceInfo {
  const i = AIR_MISSION_INFO[m];
  return { name: i.name, icon: AIR_ICON[m], help: i.help, pick: AIR_PICK[m] };
}

/** The chip line while picking. */
export const PICK_LABEL: Record<PillarPick, string> = {
  bombard: 'Bombard: click an enemy coast. Esc lets them pick the nearest one.',
  blockade: 'Blockade: click an enemy port. Esc lets them pick the nearest one.',
  front: 'Support front: click the front to hold behind. Esc cancels.',
  airSupport: 'Air support: click an attack or front. Esc cancels.',
  airStrategic: 'Strategic bombing: click a city or any land of the nation to raid. Esc cancels.',
  airSuperiority: 'Air superiority: click where the fighters patrol (your land or the front). Esc patrols over the airfield.',
};

// ------------------------------------------------------------------------------------------------ helpers

const tileAt = (state: GameState, x: number, y: number): number => {
  const w = state.map.width;
  return Math.max(0, Math.min(state.map.height - 1, Math.round(y))) * w + Math.max(0, Math.min(w - 1, Math.round(x)));
};
export const unitTileOf = (state: GameState, u: Unit): number => tileAt(state, u.x, u.y);

function ownUnits(state: GameState, me: number, ids: readonly number[], type: Unit['type']): Unit[] {
  const want = new Set(ids);
  return state.units.filter((u) => want.has(u.id) && u.owner === me && u.type === type && u.hp > 0);
}

function nationName(state: GameState, me: number, id: number): string {
  if (id === me) return 'your';
  return id > 0 ? `${state.players[id]?.name ?? 'enemy'}'s` : 'neutral';
}

/** Veterancy level 0..3 and progress to the next one (0..1; 1 at the top level). */
export function vetOf(u: Unit): { level: number; next: number } {
  const steps = u.type === 'warship' ? NAVY_VET_XP : ARMOR_VET_XP;
  const level = Math.max(0, Math.min(steps.length, u.vet ?? 0));
  if (level >= steps.length) return { level, next: 1 };
  const lo = level > 0 ? steps[level - 1] : 0;
  const hi = steps[level];
  return { level, next: Math.max(0, Math.min(1, ((u.xp ?? 0) - lo) / Math.max(1, hi - lo))) };
}
export const VET_MAX = 3;

/** The stance all the given ships share, or null when they differ (or none are there). */
export function sharedStance(state: GameState, me: number, ids: readonly number[]): WarshipStance | null {
  let s: WarshipStance | null = null;
  for (const u of ownUnits(state, me, ids, 'warship')) {
    const t = warshipStance(u);
    if (s === null) s = t;
    else if (s !== t) return null;
  }
  return s;
}
export function sharedMode(state: GameState, me: number, ids: readonly number[]): DivisionMode | null {
  let s: DivisionMode | null = null;
  for (const u of ownUnits(state, me, ids, 'tankDivision')) {
    const t = divisionMode(u);
    if (s === null) s = t;
    else if (s !== t) return null;
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ status lines

/** What a warship does in words, stance first ("Bombarding Azuria's coast"); '' = let forces.unitDoing say it. */
export function warshipOrderLine(state: GameState, me: number, u: Unit): string {
  const st = warshipStance(u);
  if (u.state === 4) {
    const s = u.station !== undefined ? state.units.find((q) => q.id === u.station) : undefined;
    return s ? `Escorting your ${s.type === 'transport' ? 'transport' : 'trade ship'}` : 'Escorting';
  }
  if (u.state === 3 && u.station !== undefined && u.station >= 0 && u.station < state.map.owner.length) {
    const b = buildingAt(state, u.station);
    const o = state.map.owner[u.station];
    const arrived = !u.path.length || u.pathPos >= u.path.length;
    if (b && b.type === 'port' && st === 'blockade') return `${arrived ? 'Blockading' : 'Sailing to blockade'} ${nationName(state, me, b.owner)} port`;
    return `${arrived ? 'Shelling' : 'Sailing to shell'} ${nationName(state, me, o)} coast`;
  }
  if (st === 'escort' && u.state === 0) return 'Escort: waiting for a transport or trade ship';
  if ((st === 'bombard' || st === 'blockade') && u.state === 0) return st === 'bombard' ? 'Waiting for an enemy coast at war in reach' : 'Waiting for an enemy port at war in reach';
  return '';
}

/** Strength / mode line for a division ("Support front · 72% strength · refitting"). */
export function divisionOrderLine(state: GameState, me: number, u: Unit): string {
  const mode = divisionMode(u);
  const pct = Math.round(divisionStrength(u) * 100);
  const parts: string[] = [];
  if (u.state === 3) parts.push('In a spearhead');
  else if (mode === 'support') {
    const f = u.station ?? -1;
    const o = f >= 0 && f < state.map.owner.length ? state.map.owner[f] : 0;
    parts.push(o > 0 && o !== me ? `Supporting the front with ${state.players[o]?.name ?? 'the enemy'}` : 'Supporting a front');
  } else if (mode === 'refit') parts.push(u.state === 1 ? 'Driving to a Factory to refit' : 'Refitting at a Factory');
  else parts.push(u.state === 1 ? 'Driving to its new position' : 'Holding');
  parts.push(`${pct}% strength`);
  if (pct < 99 && u.state !== 3 && u.state !== 1) parts.push('refitting');
  return parts.join(' · ');
}

export interface WingStatus {
  mission: AirMission;
  /** "Supporting the front with Azuria · next sortie 12 s" */
  line: string;
  /** bombers per sortie */
  size: number;
  bombers: number;
  fighters: number;
  cap: number;
  /** seconds to the next sortie (support / strategic), -1 = none */
  nextIn: number;
  sorties: number;
  refill: boolean;
  /** tiles: mission reach, support zone radius, patrol radius */
  range: number;
  zone: number;
  patrol: number;
  /** support / strategic: the nation set against (0 = none); superiority: patrol centre tile (-1 = the airfield) */
  foe: number;
  target: number;
}

export function wingStatus(state: GameState, b: Building): WingStatus {
  const w = wingOf(state, b);
  const mission = airMissionOf(state, b);
  const tps = TICKS_PER_SECOND;
  const nextIn = w && (mission === 'support' || mission === 'strategic') ? Math.max(0, Math.ceil((w.nextTick - state.tick) / tps)) : -1;
  const foe = w?.targetOwner ?? 0;
  const fname = foe > 0 ? state.players[foe]?.name ?? 'the enemy' : 'the enemy';
  let line: string;
  switch (mission) {
    case 'support':
      if (b.bombers <= 0) line = `Support: no bombers here (${w?.refill ? 'buying more' : 'build some'})`;
      else if (foe > 0 && !state.attacks.some((a) => a.attacker === b.owner && a.target === foe)) line = `Support: attack ${fname} on this front and the bombers join in`;
      else line = `Supporting your attack on ${fname} · next sortie ${nextIn} s`;
      break;
    case 'strategic': {
      const raid = foe > 0 ? airRaidOn(state, foe) : null;
      line = b.bombers <= 0 ? `Strategic: no bombers here (${w?.refill ? 'buying more' : 'build some'})` : `Raiding ${fname}${raid ? ` · income −${Math.round(raid.cut * 100)}%` : ''} · next ${nextIn} s`;
      break;
    }
    case 'superiority':
      line = b.fighters <= 0 ? 'Air superiority: no fighters here (build some)' : `Air superiority · ${b.fighters} fighter${b.fighters === 1 ? '' : 's'} on patrol`;
      break;
    default:
      line = b.bombers + b.fighters > 0 ? 'Idle: no automatic sorties. Pick Support to send the bombers with your attacks' : 'Idle: buy bombers, then pick Support to send them with your attacks';
  }
  return {
    mission,
    line,
    size: airWingSize(state, b),
    bombers: b.bombers,
    fighters: b.fighters,
    cap: airWingCap(b),
    nextIn,
    sorties: w?.sorties ?? 0,
    refill: w?.refill ?? true,
    range: airWingRange(b),
    zone: airSupportRadius(b),
    patrol: airPatrolRadius(b),
    foe,
    target: w?.target ?? -1,
  };
}

// ------------------------------------------------------------------------------------------------ orders

/** Sets the stance of the selected warships; stances that aim at a place enter the map pick (optional). */
export function setStance(state: GameState, ui: UiState, dispatch: Dispatch, ids: readonly number[], stance: WarshipStance): string {
  const ships = ownUnits(state, state.humanId, ids, 'warship').map((u) => u.id).slice(0, MAX_GROUP_UNITS);
  if (!ships.length) return 'Select warships first';
  const r = dispatch({ type: 'setUnitStance', unitIds: ships, stance });
  if (!r.ok) return r.reason ?? 'Not possible now';
  const pick = STANCE_INFO[stance].pick;
  if (pick) ui.mode = { kind: 'pillarPick', pick, unitIds: ships, airfield: -1, label: PICK_LABEL[pick] };
  return '';
}

/** Sets the mode of the selected divisions; 'support' waits for the front click (it needs one). */
export function setMode(state: GameState, ui: UiState, dispatch: Dispatch, ids: readonly number[], mode: DivisionMode): string {
  const tanks = ownUnits(state, state.humanId, ids, 'tankDivision').map((u) => u.id).slice(0, MAX_GROUP_UNITS);
  if (!tanks.length) return 'Select tank divisions first';
  if (mode === 'support') {
    ui.mode = { kind: 'pillarPick', pick: 'front', unitIds: tanks, airfield: -1, label: PICK_LABEL.front };
    return '';
  }
  const r = dispatch({ type: 'setDivisionMode', unitIds: tanks, mode });
  return r.ok ? '' : r.reason ?? 'Not possible now';
}

/**
 * Sets an airfield's mission (airfield = its tile, -1 = every airfield that reaches). Missions with a target enter the
 * map pick; superiority is set at once over the airfield and the pick can move the patrol.
 */
export function setMission(state: GameState, ui: UiState, dispatch: Dispatch, airfield: number, mission: AirMission, refill?: boolean): string {
  const pick = AIR_PICK[mission];
  if (mission === 'idle' || mission === 'superiority') {
    const r = dispatch(refill === undefined ? { type: 'setAirMission', airfield, mission } : { type: 'setAirMission', airfield, mission, refill });
    if (!r.ok) return r.reason ?? 'Not possible now';
  }
  if (pick) ui.mode = { kind: 'pillarPick', pick, unitIds: [], airfield, label: PICK_LABEL[pick] };
  return '';
}

/** The refill flag of an airfield's wing ('re-buy losses'), toggled with the same mission and target. */
export function toggleRefill(state: GameState, dispatch: Dispatch, b: Building): string {
  const s = wingStatus(state, b);
  const a: Action = s.target >= 0 && s.mission !== 'idle' ? { type: 'setAirMission', airfield: b.tile, mission: s.mission, target: s.target, refill: !s.refill } : { type: 'setAirMission', airfield: b.tile, mission: s.mission, refill: !s.refill };
  const r = dispatch(a);
  return r.ok ? '' : r.reason ?? 'Not possible now';
}

/** Water next to `tile` (within r) in the sea of `from`, nearest to tile; -1 = none. */
function waterNear(state: GameState, tile: number, from: number, r: number): number {
  const map = state.map;
  const w = map.width;
  if (isWater(map.terrain[tile]) && (from < 0 || sameWater(map, from, tile))) return tile;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  let best = -1;
  let bestD = Infinity;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= map.height) continue;
      const d = dx * dx + dy * dy;
      if (d > r * r || d >= bestD) continue;
      const t = y * w + x;
      if (!isWater(map.terrain[t]) || (from >= 0 && !sameWater(map, from, t))) continue;
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** The enemy port nearest the click (within 5 tiles), or null. */
function portNear(state: GameState, me: number, tile: number): Building | null {
  const w = state.map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  let best: Building | null = null;
  let bestD = 26;
  for (const b of state.buildings.values()) {
    if (b.type !== 'port' || b.owner === me || b.owner <= 0 || areAllied(state, me, b.owner)) continue;
    const dx = (b.tile % w) - cx;
    const dy = ((b.tile / w) | 0) - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/** A click in the 'pillarPick' mode: the order, or why not. ok = leave the mode. */
export function pillarPickClick(state: GameState, ui: UiState, dispatch: Dispatch, tile: number): { ok: boolean; reason: string; info?: string } {
  const m = ui.mode;
  if (m.kind !== 'pillarPick') return { ok: false, reason: '' };
  const me = state.humanId;
  const map = state.map;
  if (tile < 0 || tile >= map.owner.length) return { ok: false, reason: 'Click on the map' };
  const fail = (r: { ok: boolean; reason?: string }, why: string) => ({ ok: r.ok, reason: r.ok ? '' : r.reason ?? why });
  switch (m.pick) {
    case 'bombard':
    case 'blockade': {
      const ships = ownUnits(state, me, m.unitIds, 'warship');
      if (!ships.length) return { ok: true, reason: '' };
      const from = unitTileOf(state, ships[0]);
      let aim = tile;
      let foe = map.owner[tile];
      if (m.pick === 'blockade') {
        const port = portNear(state, me, tile);
        if (!port) return { ok: false, reason: 'Click an enemy port (or Esc to let them pick one)' };
        aim = port.tile;
        foe = port.owner;
      } else if (isWater(map.terrain[tile])) foe = 0;
      else if (foe === me || foe <= 0 || areAllied(state, me, foe)) return { ok: false, reason: 'Click an enemy coast (or Esc to let them pick one)' };
      const water = waterNear(state, aim, from, 6);
      if (water < 0) return { ok: false, reason: 'Your warships cannot reach that coast from their sea' };
      const r = dispatch({ type: 'moveWarships', unitIds: ships.map((u) => u.id).slice(0, MAX_GROUP_UNITS), tile: water });
      const info = r.ok && foe > 0 && !atWar(state, me, foe) ? `They open fire once you are at war with ${state.players[foe]?.name ?? 'them'}` : undefined;
      return { ...fail(r, 'Your warships cannot reach there'), info };
    }
    case 'front': {
      const tanks = ownUnits(state, me, m.unitIds, 'tankDivision');
      if (!tanks.length) return { ok: true, reason: '' };
      if (isWater(map.terrain[tile])) return { ok: false, reason: 'Click a land tile at your front' };
      return fail(dispatch({ type: 'setDivisionMode', unitIds: tanks.map((u) => u.id).slice(0, MAX_GROUP_UNITS), mode: 'support', front: tile }), 'Pick a tile at one of your fronts');
    }
    case 'airSupport':
    case 'airStrategic':
    case 'airSuperiority': {
      const mission: AirMission = m.pick === 'airSupport' ? 'support' : m.pick === 'airStrategic' ? 'strategic' : 'superiority';
      const b = m.airfield >= 0 ? buildingAt(state, m.airfield) : undefined;
      const refill = b ? wingOf(state, b)?.refill ?? true : true;
      return fail(dispatch({ type: 'setAirMission', airfield: m.airfield, mission, target: tile, refill }), 'Not possible there');
    }
  }
}

// ------------------------------------------------------------------------------------------------ encirclement hint

const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];

export interface PocketPreview {
  /** tiles that would collapse (approximate) */
  tiles: number[];
  victim: number;
}

const pocketCache = new WeakMap<GameState, { key: string; p: PocketPreview | null; at: number }>();

/**
 * Would this spearhead (as far as it is expected to get) cut off a pocket of the target's land? Mirrors
 * armor2.collapsePockets on a copy: the band along the line counts as ours, then the target's pieces touching it are
 * flooded; a piece closed by our / allied land, water and the map edge, without the capital, collapses. Client only,
 * approximate (the real spearhead decides), bounded, cached per tick.
 */
export function pocketPreview(state: GameState, me: number, p: SpearheadPreview | null, now = 0): PocketPreview | null {
  if (!p || p.reason || p.launch < 0 || p.expectedDepth < 2) return null;
  const key = `${p.launch}:${p.path[0] ?? -1}:${p.expectedDepth}:${state.tick >> 3}`;
  const c = pocketCache.get(state);
  if (c && c.key === key) return c.p;
  const out = computePocket(state, me, p);
  pocketCache.set(state, { key, p: out, at: now });
  return out;
}

function computePocket(state: GameState, me: number, p: SpearheadPreview): PocketPreview | null {
  const map = state.map;
  const { width: w, height: h, owner, terrain } = map;
  const line = p.path.slice(0, p.expectedDepth);
  let victim = 0;
  for (const t of line) {
    const o = owner[t];
    if (o > 0 && o !== me) {
      victim = o;
      break;
    }
  }
  const vp = state.players[victim];
  if (victim <= 0 || !vp || !vp.alive || areAllied(state, me, victim)) return null;
  const band = new Set<number>();
  const half = (TANK_SPEARHEAD_WIDTH - 1) >> 1;
  for (const t of line) {
    const x = t % w;
    const y = (t / w) | 0;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (owner[j] === victim) band.add(j);
      }
    }
  }
  const seeds: number[] = [];
  for (const t of band) {
    const x = t % w;
    const y = (t / w) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k];
      const ny = y + DY4[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (owner[j] === victim && !band.has(j)) seeds.push(j);
    }
  }
  const cap = Math.min(ARMOR_POCKET_MAX_TILES, Math.floor((vp.tiles - band.size - 1) / 2));
  if (cap < 1 || !seeds.length) return null;
  const visited = new Set<number>(band);
  /** tiles of pieces already found open: meeting one means this piece is connected to it (open too) */
  const openTiles = new Set<number>();
  const closes = (o: number, t: number): boolean => o === me || isWater(terrain[t]) || (o > 0 && o !== victim && areAllied(state, me, o));
  const tiles: number[] = [];
  let budget = 2 * Math.min(ARMOR_POCKET_MAX_TILES, 1500);
  for (const s0 of seeds) {
    if (visited.has(s0)) continue;
    const piece: number[] = [s0];
    visited.add(s0);
    let open = false;
    for (let head = 0; head < piece.length && !open; head++) {
      if (piece.length > cap || --budget <= 0) {
        open = true;
        break;
      }
      const t = piece[head];
      if (t === vp.capital) {
        open = true;
        break;
      }
      const x = t % w;
      const y = (t / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k];
        const ny = y + DY4[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const o = owner[j];
        if (o === victim) {
          if (band.has(j)) continue;
          if (openTiles.has(j)) {
            open = true;
            break;
          }
          if (!visited.has(j)) {
            visited.add(j);
            piece.push(j);
          }
          continue;
        }
        if (!closes(o, j)) {
          open = true;
          break;
        }
      }
    }
    if (!open) for (const t of piece) tiles.push(t);
    else for (const t of piece) openTiles.add(t);
    if (budget <= 0) break;
  }
  return tiles.length ? { tiles, victim } : null;
}

/** "Cuts off ~40 tiles of Azuria: they collapse" ('' = no pocket). */
export function pocketLine(state: GameState, p: PocketPreview | null): string {
  if (!p || !p.tiles.length) return '';
  return `Encircles ~${p.tiles.length} tiles of ${state.players[p.victim]?.name ?? 'the enemy'}: they collapse`;
}

// ------------------------------------------------------------------------------------------------ overview

export interface PillarSummary {
  ships: number;
  shipsWorking: number;
  tanks: number;
  tanksSupporting: number;
  wings: number;
  wingsOnMission: number;
  /** enemy ports your warships blockade */
  blockading: number;
  /** your own ports under blockade */
  blockaded: number;
}

/** Counts for the Forces drawer's at-a-glance line. */
export function pillarSummary(state: GameState, me: number): PillarSummary {
  const out: PillarSummary = { ships: 0, shipsWorking: 0, tanks: 0, tanksSupporting: 0, wings: 0, wingsOnMission: 0, blockading: 0, blockaded: 0 };
  for (const u of state.units) {
    if (u.owner !== me || u.hp <= 0) continue;
    if (u.type === 'warship') {
      out.ships++;
      if (u.state === 2 || u.state === 3 || u.state === 4) out.shipsWorking++;
    } else if (u.type === 'tankDivision') {
      out.tanks++;
      if (divisionMode(u) === 'support' || u.state === 3) out.tanksSupporting++;
    }
  }
  for (const b of buildingsOf(state, me, 'airfield')) {
    if (b.buildLeft > 0) continue;
    out.wings++;
    if (airMissionOf(state, b) !== 'idle') out.wingsOnMission++;
  }
  out.blockaded = blockadedPorts(state, me).length;
  if (out.ships) for (const b of state.buildings.values()) if (b.type === 'port' && b.owner !== me && b.owner > 0 && portBlockadedBy(state, b.tile) === me) out.blockading++;
  return out;
}

/** Hull share 0..1 of a warship (max hp grows with veterancy: the sim's warshipMaxHp). */
export function hullShare(u: Unit, maxHp: number): number {
  return Math.max(0, Math.min(1, u.hp / Math.max(1, maxHp || UNITS[u.type].hp)));
}

/** True when the player can use air missions at all (Flight researched). */
export function airReady(me: Player): boolean {
  return hasTech(me, 'flight');
}
