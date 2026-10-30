// Special units on the client: warships, transports, bombers, fighters, cargo planes, rockets, atom bombs and
// artillery. One place phrases them for the Forces drawer, the build bar's unit items, the map hover card, the
// selected-unit card and the advisor:
//   - UNIT_TEXT: what each one does, what stops it and how to unlock it (one line each)
//   - unitBuildStatus(): can the player buy one now (and where), else the one line that says why not
//   - buildUnit(): buys one at the best site (the port / airfield nearest the view with room)
//   - unitDoing() / unitPlace(): what a unit on the map is doing, in words ("heading to Azuria's coast")
// The rules stay in the sim (buildWarship, buildAircraft, moveWarship); this file only reads and phrases them.
import { aircraftCap, buildingsOf } from '../sim/buildings';
import { BOMBER_RADIUS, TECHS, UNITS, WARSHIP_RANGE } from '../sim/config';
import { areAllied } from '../sim/diplomacy';
import { armyTotal } from '../sim/economy';
import { forEachInRadius } from '../sim/grid';
import { buildingAllowed, unitAllowed } from '../sim/rules';
import { hasTech } from '../sim/tech';
import { isWater } from '../sim/types';
import type { Building, GameState, Player, Unit, UnitType } from '../sim/types';
import { formatCount } from './render/common';
import type { IconId } from './icons';
import type { Dispatch } from './uiState';

/** Units the build bar sells (Military tab). */
export type BuyableUnit = 'warship' | 'bomber' | 'fighter';
export const BUYABLE_UNITS: readonly BuyableUnit[] = ['warship', 'bomber', 'fighter'];

export type SpecialId = 'warship' | 'transport' | 'bomber' | 'fighter' | 'transportPlane' | 'rocket' | 'atomBomb' | 'artillery';

export interface UnitText {
  name: string;
  icon: IconId;
  /** what it does (one line) */
  what: string;
  /** what stops it (one line) */
  counter: string;
  /** how to get it (one line, starts with a verb) */
  unlock: string;
}

export const UNIT_TEXT: Record<SpecialId, UnitText> = {
  warship: {
    name: 'Warship',
    icon: 'warship',
    what: `Sinks enemy ships within ${WARSHIP_RANGE} tiles and shells enemy coasts within ${WARSHIP_RANGE / 2} tiles while you are at war.`,
    counter: 'Only other warships sink it.',
    unlock: 'Research Navigation and build a Port',
  },
  transport: {
    name: 'Transport',
    icon: 'transport',
    what: 'Carries troops over the sea: click land across the water to send one.',
    counter: 'Enemy warships sink it with everyone aboard.',
    unlock: 'Own a coast (a Port makes them faster)',
  },
  bomber: {
    name: 'Bomber',
    icon: 'bomber',
    what: `Waits at its Airfield; a bombing run (X) wrecks buildings and troops within ${BOMBER_RADIUS} tiles, then it flies home.`,
    counter: 'SAM sites and enemy fighters shoot it down.',
    unlock: 'Research Flight and build an Airfield',
  },
  fighter: {
    name: 'Fighter',
    icon: 'fighter',
    what: 'Waits at its Airfield and shoots down enemy bombers and cargo planes that fly nearby.',
    counter: 'Each interception needs a reload; losing the Airfield loses its planes.',
    unlock: 'Research Flight and build an Airfield',
  },
  transportPlane: {
    name: 'Paratroopers',
    icon: 'transportPlane',
    what: 'A cargo plane drops infantry behind the lines (K): they take the tile and attack from there.',
    counter: 'SAM sites and enemy fighters can down the plane with everyone aboard.',
    unlock: 'Research Flight and build an Airfield',
  },
  rocket: {
    name: 'Rocket',
    icon: 'rocket',
    what: 'Fired from a Missile Silo (I): hits anywhere on the map and destroys the buildings around the target.',
    counter: 'SAM sites shoot rockets down.',
    unlock: 'Research Rocketry and build a Missile Silo',
  },
  atomBomb: {
    name: 'Atom bomb',
    icon: 'atomBomb',
    what: 'Fired from a Missile Silo (O): wipes out a wide area, your own land too, and leaves fallout.',
    counter: 'SAM sites need two hits to stop it.',
    unlock: 'Research Nuclear Fission and build a Missile Silo',
  },
  artillery: {
    name: 'Artillery',
    icon: 'artillery',
    what: 'A troop type: breaks forts and hills, and fires the artillery barrage (Z).',
    counter: 'Weak on its own: keep infantry and armor with it.',
    unlock: 'Build an Arsenal and raise Artillery in the Army drawer (U)',
  },
};

// ------------------------------------------------------------------------------------------------ buying

export interface UnitBuildStatus {
  /** false: this game's rules switch it off (the item is hidden) */
  allowed: boolean;
  /** true: a click buys one now */
  ok: boolean;
  /** locked: true when the tech or the building is missing (not just the money) */
  locked: boolean;
  /** ok: where and for how much; otherwise exactly why not and what to do */
  line: string;
  /** the port / airfield tile it would be built at (-1 = none) */
  site: number;
}

export function priceText(type: UnitType): string {
  const u = UNITS[type];
  return [`${formatCount(u.gold)} gold`, u.iron ? `${formatCount(u.iron)} iron` : '', u.oil ? `${formatCount(u.oil)} oil` : ''].filter(Boolean).join(', ');
}

function payLine(me: Player, type: UnitType): string {
  const u = UNITS[type];
  const miss: string[] = [];
  if (me.gold < u.gold) miss.push(`${formatCount(u.gold)} gold`);
  if (me.iron < u.iron) miss.push(`${formatCount(u.iron)} iron`);
  if (me.oil < u.oil) miss.push(`${formatCount(u.oil)} oil`);
  return miss.length ? `Needs ${miss.join(', ')}` : '';
}

/** Aircraft at an airfield: stored plus its bombers out flying (the cap counts both). */
export function aircraftAt(state: GameState, b: Building): number {
  let n = b.bombers + b.fighters;
  for (const u of state.units) if (u.type === 'bomber' && u.home === b.tile && u.owner === b.owner && u.hp > 0) n++;
  return n;
}

function hasOpenWater(state: GameState, tile: number): boolean {
  const m = state.map;
  const w = m.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < m.height && isWater(m.terrain[ny * w + nx])) return true;
  }
  return false;
}

function nearest(state: GameState, list: Building[], near: { x: number; y: number } | null): Building | null {
  if (!list.length) return null;
  if (!near) return list[0];
  const w = state.map.width;
  let best = list[0];
  let bd = Infinity;
  for (const b of list) {
    const d = ((b.tile % w) - near.x) ** 2 + (((b.tile / w) | 0) - near.y) ** 2;
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}

/** Can the player buy a warship / bomber / fighter now, and where (the site nearest `near`, tile coords)? */
export function unitBuildStatus(state: GameState, me: Player, kind: BuyableUnit, near: { x: number; y: number } | null = null): UnitBuildStatus {
  const site = kind === 'warship' ? 'port' : 'airfield';
  const st: UnitBuildStatus = { allowed: unitAllowed(state, kind) && buildingAllowed(state, site), ok: false, locked: true, line: '', site: -1 };
  if (!st.allowed) return { ...st, line: `${UNITS[kind].name}s are off in this game` };
  const tech = kind === 'warship' ? 'navigation' : 'flight';
  const all = buildingsOf(state, me.id, site);
  const done = all.filter((b) => b.buildLeft <= 0);
  if (!hasTech(me, tech)) {
    const pre = TECHS[tech].requires.filter((t) => !hasTech(me, t)).map((t) => TECHS[t].name);
    const research = pre.length ? `Research ${pre.join(' + ')}, then ${TECHS[tech].name}` : `Research ${TECHS[tech].name}`;
    return { ...st, line: done.length ? `${research} (T)` : `${research} (T) and build ${kind === 'warship' ? 'a Port' : 'an Airfield'}` };
  }
  if (!done.length) {
    if (all.length) return { ...st, line: `Your ${kind === 'warship' ? 'Port' : 'Airfield'} is being built` };
    return { ...st, line: kind === 'warship' ? 'Build a Port on your coast first (Special tab, E)' : 'Build an Airfield first (Special tab, F)' };
  }
  let usable = done;
  if (kind === 'warship') {
    usable = done.filter((b) => hasOpenWater(state, b.tile));
    if (!usable.length) return { ...st, line: 'Your Ports have no open water next to them' };
  } else {
    usable = done.filter((b) => aircraftAt(state, b) < aircraftCap(b));
    if (!usable.length) return { ...st, line: 'Your Airfields are full: upgrade one for more room' };
  }
  st.locked = false;
  const b = nearest(state, usable, near)!;
  st.site = b.tile;
  const pay = payLine(me, kind);
  if (pay) return { ...st, line: pay };
  const where = kind === 'warship' ? 'Port' : 'Airfield';
  return { ...st, ok: true, line: `Builds one at your ${where} nearest the view: ${priceText(kind)}` };
}

/** Buys one at the best site; returns '' when it worked, else the reason. */
export function buildUnit(state: GameState, me: Player, dispatch: Dispatch, kind: BuyableUnit, near: { x: number; y: number } | null): string {
  const st = unitBuildStatus(state, me, kind, near);
  if (!st.ok) return st.line;
  const r = kind === 'warship' ? dispatch({ type: 'buildWarship', port: st.site }) : dispatch({ type: 'buildAircraft', airfield: st.site, kind });
  return r.ok ? '' : r.reason ?? 'Not possible now';
}

// ------------------------------------------------------------------------------------------------ reading the map

function tileOf(state: GameState, u: Unit): number {
  const w = state.map.width;
  const x = Math.max(0, Math.min(w - 1, Math.round(u.x)));
  const y = Math.max(0, Math.min(state.map.height - 1, Math.round(u.y)));
  return y * w + x;
}

function nameOf(state: GameState, me: Player, id: number): string {
  if (id === me.id) return 'your';
  const p = state.players[id];
  return p ? `${p.name}'s` : 'unknown';
}

/** Where a tile is in words: "Azuria's coast", "your coast", "open sea", "Azuria's land". */
export function unitPlace(state: GameState, me: Player, tile: number): string {
  const m = state.map;
  if (tile < 0 || tile >= m.owner.length) return 'open sea';
  const o = m.owner[tile];
  if (!isWater(m.terrain[tile])) return o > 0 ? `${nameOf(state, me, o)} ${m.coastal[tile] ? 'coast' : 'land'}` : 'the wilderness';
  // water: the nearest owned coast within a few tiles
  let best = -1;
  let bd = Infinity;
  forEachInRadius(m, tile, 6, (i, d) => {
    if (d < bd && m.owner[i] > 0 && !isWater(m.terrain[i])) {
      bd = d;
      best = m.owner[i];
    }
  });
  return best > 0 ? `off ${nameOf(state, me, best)} coast` : 'open sea';
}

/** A hostile ship within warship range of a warship (it is fighting it). */
function enemyShipNear(state: GameState, u: Unit): Unit | null {
  const r2 = WARSHIP_RANGE * WARSHIP_RANGE;
  for (const s of state.units) {
    if (s === u || s.hp <= 0 || s.owner === u.owner) continue;
    if (s.type !== 'warship' && s.type !== 'transport' && s.type !== 'tradeShip') continue;
    if (areAllied(state, u.owner, s.owner)) continue;
    if (s.type === 'tradeShip' && (s.targetOwner === u.owner || areAllied(state, s.targetOwner, u.owner))) continue;
    if ((s.x - u.x) ** 2 + (s.y - u.y) ** 2 <= r2) return s;
  }
  return null;
}

/** What a unit is doing, one short line ("Heading to Azuria's coast", "Patrolling off your coast"). */
export function unitDoing(state: GameState, me: Player, u: Unit): string {
  switch (u.type) {
    case 'warship': {
      const foe = enemyShipNear(state, u);
      if (foe) return `Fighting ${nameOf(state, me, foe.owner)} ${foe.type === 'tradeShip' ? 'trade ship' : UNITS[foe.type].name.toLowerCase()}`;
      if (u.state === 1) {
        const to = unitPlace(state, me, u.target);
        return to.startsWith('off ') ? `Sailing ${to}` : `Sailing to ${to}`;
      }
      const at = unitPlace(state, me, tileOf(state, u));
      return `Patrolling ${at === 'open sea' ? 'the open sea' : at}`;
    }
    case 'transport':
      return `${formatCount(armyTotal(u.troops))} troops heading to ${unitPlace(state, me, u.target)}`;
    case 'tradeShip':
      return `Carrying ${formatCount(u.cargo)} gold to ${state.players[u.targetOwner]?.name ?? 'a port'}`;
    case 'bomber':
      return u.state === 0 ? `Flying to bomb ${state.players[u.targetOwner]?.name ?? 'a target'}` : 'Flying home to its Airfield';
    case 'transportPlane':
      return `Dropping ${formatCount(armyTotal(u.troops))} paratroopers on ${unitPlace(state, me, u.target)}`;
    case 'rocket':
    case 'atomBomb':
      return `Falling on ${unitPlace(state, me, u.target)}`;
    case 'fighter':
      return 'Intercepting planes';
  }
  return '';
}

/** A hostile unit coming at the player (their transports, bombers, cargo planes and missiles aimed at them). */
export function isIncoming(state: GameState, me: number, u: Unit): boolean {
  if (me <= 0 || u.owner === me || u.hp <= 0 || areAllied(state, me, u.owner)) return false;
  const t = u.target >= 0 && u.target < state.map.owner.length ? state.map.owner[u.target] : 0;
  switch (u.type) {
    case 'transport':
    case 'transportPlane':
    case 'rocket':
    case 'atomBomb':
      return t === me;
    case 'bomber':
      return u.state === 0 && u.targetOwner === me;
    default:
      return false;
  }
}

/** A unit's name as the cards say it ("Warship", "Cargo plane"). */
export function unitName(u: Unit): string {
  return u.type === 'transportPlane' ? 'Cargo plane' : UNITS[u.type].name;
}

/** Icon of a unit type (icons.ts). */
export function unitIcon(type: UnitType): IconId {
  return type as IconId;
}

/** HP as "2.5 of 3" (only warships and atom bombs have more than 1). */
export function hpText(u: Unit): string {
  const max = UNITS[u.type].hp;
  const v = Math.max(0, u.hp);
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} of ${max}`;
}
