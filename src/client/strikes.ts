// Special strikes on the client: artillery barrage, bombing run, paratroopers, rocket and atom bomb.
// One place answers, for the command bar, the hotkeys, the radial menu, the advisor and the map preview:
//   - strikeStatus(): ready / cooling down / locked (with the one line that says how to unlock it) / blocked
//   - modeFor() / strikeOfMode(): the target mode a strike uses
//   - strikeTarget(): what a click on a tile would do (the launch site picked, or why not) and what the blast hits
//   - instruction(): the line at the top of the screen while aiming
//   - barrageReach(): which tiles a barrage can reach (the shaded zone while aiming)
// The rules stay in the sim (canBarrage, canParadrop, launchBomber, launchMissile); this file only phrases them and
// checks a click before it is sent, so a wasted strike shows its reason at the cursor instead.
import { artilleryOf, barrageCooldown, barrageRadius, barrageRange, barrageReadyIn } from '../sim/barrage';
import { airfieldRadius, buildingAt, buildingsOf, chargesReady, isDisabled, nextChargeIn, samRadius } from '../sim/buildings';
import {
  ATOM_RADIUS,
  BARRAGE_DELAY,
  BARRAGE_GOLD,
  BARRAGE_MIN_ARTILLERY,
  BARRAGE_RANGE,
  BOMBER_RADIUS,
  PARADROP_COOLDOWN,
  PARADROP_MIN_TROOPS,
  ROCKET_RADIUS,
  UNITS,
} from '../sim/config';
import { areAllied } from '../sim/diplomacy';
import { forEachInRadius } from '../sim/grid';
import { buildingAllowed, peaceReason, unitAllowed } from '../sim/rules';
import { gameSeconds } from '../sim/state';
import { unitCost } from '../sim/units';
import { hasTech } from '../sim/tech';
import type { Action, Building, GameEvent, GameState, Player, UnitType } from '../sim/types';
import type { IconId } from './icons';
import { formatCount } from './render/common';
import { airfieldsNear, barrageCheck, paradropRange, planParadrop } from './simx';
import type { TargetMode, UiState } from './uiState';

export type StrikeId = 'barrage' | 'bomb' | 'paradrop' | 'rocket' | 'atomBomb';
export const STRIKE_ORDER: readonly StrikeId[] = ['barrage', 'bomb', 'paradrop', 'rocket', 'atomBomb'];

export interface StrikeInfo {
  id: StrikeId;
  name: string;
  /** button label (short) */
  label: string;
  key: string;
  /** picture from icons.ts */
  icon: IconId;
  /** line icon for toasts and the radial menu */
  line: string;
  /** what it does, one line */
  what: string;
  /** what stops it, one line */
  counter: string;
}

export const STRIKES: Record<StrikeId, StrikeInfo> = {
  barrage: {
    id: 'barrage',
    name: 'Artillery barrage',
    label: 'Barrage',
    key: 'Z',
    icon: 'artillery',
    line: 'barrage',
    what: `Shells enemy land up to ${BARRAGE_RANGE} tiles from your border: kills troops, silences forts and SAM sites.`,
    counter: 'Nothing stops shells, not even SAM sites. Only range limits them.',
  },
  bomb: {
    id: 'bomb',
    name: 'Bombing run',
    label: 'Bomb',
    key: 'X',
    icon: 'bomber',
    line: 'bomb',
    what: `A bomber wrecks buildings and kills troops within ${BOMBER_RADIUS} tiles, then flies home.`,
    counter: 'SAM sites and enemy fighters shoot bombers down on the way.',
  },
  paradrop: {
    id: 'paradrop',
    name: 'Paratroopers',
    label: 'Paras',
    key: 'K',
    icon: 'transportPlane',
    line: 'paradrop',
    what: 'A cargo plane drops infantry behind the lines: they take the tile and attack from there.',
    counter: 'SAM sites and enemy fighters can down the plane with everyone aboard.',
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket',
    label: 'Rocket',
    key: 'I',
    icon: 'rocket',
    line: 'rocket',
    what: `Hits anywhere on the map: destroys every enemy building within ${ROCKET_RADIUS} tiles and kills troops.`,
    counter: 'SAM sites shoot rockets down.',
  },
  atomBomb: {
    id: 'atomBomb',
    name: 'Atom bomb',
    label: 'Atom',
    key: 'O',
    icon: 'atomBomb',
    line: 'atom',
    what: `Wipes out everything within ${ATOM_RADIUS} tiles, your own land too, and leaves fallout. Every nation will hate you.`,
    counter: 'SAM sites need two hits to stop it.',
  },
};

/** Strike for a hotkey letter (upper case), or null. */
export function strikeForKey(key: string): StrikeId | null {
  for (const id of STRIKE_ORDER) if (STRIKES[id].key === key) return id;
  return null;
}

// ------------------------------------------------------------------------------------------------ status

export type StrikeState = 'ready' | 'cooldown' | 'locked' | 'blocked';

export interface StrikeStatus {
  id: StrikeId;
  /** false: this game's modifiers make it impossible (the button is hidden) */
  allowed: boolean;
  state: StrikeState;
  /** cooldown: seconds left, and the whole reload when known (0 = unknown) */
  left: number;
  total: number;
  /** ready: what a click does; otherwise exactly why not and what to do (one plain line) */
  line: string;
  /** strikes stored and ready (bombers at airfields, loaded silo slots), -1 = not counted */
  count: number;
  /** the player has started on it (a building, a tech or troops it needs) */
  started: boolean;
}

function finished(state: GameState, me: Player, type: 'airfield' | 'silo' | 'arsenal'): Building[] {
  return buildingsOf(state, me.id, type).filter((b) => b.buildLeft <= 0);
}
function building(state: GameState, me: Player, type: 'airfield' | 'silo' | 'arsenal'): boolean {
  return buildingsOf(state, me.id, type).length > 0;
}
function payLine(me: Player, type: UnitType, state?: GameState): string {
  const u = state ? unitCost(state, me.id, type) : UNITS[type];
  const miss: string[] = [];
  if (me.gold < u.gold) miss.push(`${formatCount(u.gold)} gold`);
  if (me.iron < u.iron) miss.push(`${formatCount(u.iron)} iron`);
  if (me.oil < u.oil) miss.push(`${formatCount(u.oil)} oil`);
  return miss.length ? `Needs ${miss.join(', ')}` : '';
}

/** Seconds until one of the player's bombers is home again (-1 = none flying). */
function bomberBackIn(state: GameState, me: Player): number {
  const w = state.map.width;
  let best = -1;
  for (const u of state.units) {
    if (u.type !== 'bomber' || u.owner !== me.id || u.hp <= 0) continue;
    const hx = u.home % w;
    const hy = (u.home / w) | 0;
    let d: number;
    if (u.state === 0) {
      const tx = u.target % w;
      const ty = (u.target / w) | 0;
      d = Math.hypot(tx - u.x, ty - u.y) + Math.hypot(hx - tx, hy - ty);
    } else d = Math.hypot(hx - u.x, hy - u.y);
    const s = d / UNITS.bomber.speed;
    if (best < 0 || s < best) best = s;
  }
  return best;
}

const lockedFlight = 'Research Flight and build an Airfield';

/** Where a strike stands for the player right now. */
export function strikeStatus(state: GameState, me: Player, id: StrikeId): StrikeStatus {
  const st: StrikeStatus = { id, allowed: true, state: 'ready', left: 0, total: 0, line: '', count: -1, started: false };
  const lock = (line: string): StrikeStatus => ({ ...st, state: 'locked', line });
  const block = (line: string): StrikeStatus => ({ ...st, state: 'blocked', line });
  const cool = (left: number, total: number, line: string): StrikeStatus => ({ ...st, state: 'cooldown', left, total, line });
  switch (id) {
    case 'barrage': {
      const art = artilleryOf(state, me.id);
      st.started = art > 0 || building(state, me, 'arsenal');
      if (art < BARRAGE_MIN_ARTILLERY) {
        if (!building(state, me, 'arsenal')) return lock('Build an Arsenal, then raise Artillery in the Army drawer (U)');
        return lock(`Needs ${formatCount(BARRAGE_MIN_ARTILLERY)} artillery, you have ${formatCount(art)}: raise Artillery in the Army drawer (U)`);
      }
      const left = barrageReadyIn(state, me.id);
      if (left > 0) return cool(left, barrageCooldown(me, state), `Guns reloading: ready in ${Math.ceil(left)} s`);
      if (me.gold < BARRAGE_GOLD) return block(`Needs ${BARRAGE_GOLD} gold`);
      return { ...st, line: `Click enemy land within ${barrageRange(me)} tiles of your border. ${BARRAGE_GOLD} gold.` };
    }
    case 'bomb': {
      st.allowed = unitAllowed(state, 'bomber') && buildingAllowed(state, 'airfield');
      if (!st.allowed) return st;
      st.started = hasTech(me, 'flight') || building(state, me, 'airfield');
      if (!hasTech(me, 'flight')) return lock(`${lockedFlight}, then build a bomber there`);
      const fields = finished(state, me, 'airfield');
      if (!fields.length) return lock(building(state, me, 'airfield') ? 'Your Airfield is being built: then build a bomber there' : 'Build an Airfield, then build a bomber there');
      const stored = fields.reduce((n, b) => n + b.bombers, 0);
      st.count = stored;
      if (stored > 0) return { ...st, line: `${stored} bomber${stored === 1 ? '' : 's'} ready. Click enemy land: bombs hit ${BOMBER_RADIUS} tiles around.` };
      const back = bomberBackIn(state, me);
      if (back >= 0) return cool(back, 0, `Your bombers are flying: the next is home in about ${Math.max(1, Math.ceil(back))} s`);
      return lock('Build a bomber at your Airfield: Build menu (Tab), the Airfield, or the Forces drawer (Y)');
    }
    case 'paradrop': {
      st.allowed = unitAllowed(state, 'paradrop') && buildingAllowed(state, 'airfield');
      if (!st.allowed) return st;
      st.started = hasTech(me, 'flight') || building(state, me, 'airfield');
      if (!hasTech(me, 'flight')) return lock(lockedFlight);
      const fields = finished(state, me, 'airfield');
      if (!fields.length) return lock(building(state, me, 'airfield') ? 'Your Airfield is being built' : 'Build an Airfield');
      const left = Math.min(...fields.map((b) => b.dropCooldown));
      if (left > 0) return cool(left, PARADROP_COOLDOWN, `Next cargo plane ready in ${Math.ceil(left)} s`);
      if (me.troops.infantry < PARADROP_MIN_TROOPS) return block(`Needs ${formatCount(PARADROP_MIN_TROOPS)} infantry at home`);
      const pay = payLine(me, 'transportPlane', state);
      if (pay) return block(pay);
      const range = Math.max(...fields.map((b) => paradropRange(b, state)));
      return { ...st, line: `Click enemy or empty land up to ${range} tiles from an Airfield. Sends your attack share of infantry.` };
    }
    case 'rocket':
    case 'atomBomb': {
      const tech = id === 'rocket' ? 'rocketry' : 'nuclearFission';
      st.allowed = (id === 'rocket' || unitAllowed(state, 'atomBomb')) && buildingAllowed(state, 'silo');
      if (!st.allowed) return st;
      st.started = hasTech(me, tech) || (id === 'rocket' && building(state, me, 'silo'));
      if (!hasTech(me, tech)) {
        if (id === 'rocket') return lock('Research Rocketry and build a Missile Silo');
        return lock(building(state, me, 'silo') ? 'Research Nuclear Fission' : 'Research Nuclear Fission and build a Missile Silo');
      }
      const silos = finished(state, me, 'silo');
      if (!silos.length) return lock(building(state, me, 'silo') ? 'Your Missile Silo is being built' : 'Build a Missile Silo');
      const loaded = silos.reduce((n, b) => n + chargesReady(b), 0);
      st.count = loaded;
      if (loaded < 1) {
        const left = Math.min(...silos.map((b) => nextChargeIn(b)));
        return cool(left, 0, `Silo reloading: ready in ${Math.ceil(left)} s`);
      }
      const pay = payLine(me, id);
      if (pay) return block(pay);
      const u = UNITS[id];
      const price = `${formatCount(u.gold)} gold, ${formatCount(u.iron)} iron, ${formatCount(u.oil)} oil`;
      return { ...st, line: id === 'rocket' ? `Click any enemy land on the map. ${price}.` : `Click a target: everything within ${ATOM_RADIUS} tiles is hit, yours too. ${price}.` };
    }
  }
}

/** Every strike's status (in bar order). */
export function allStrikes(state: GameState, me: Player): StrikeStatus[] {
  return STRIKE_ORDER.map((id) => strikeStatus(state, me, id));
}

/**
 * Should the strikes group show? Not in the first minute and a half (beginners have enough to learn), unless the
 * player already started on one (an Arsenal, artillery, Flight, Rocketry ...).
 */
export function strikesRevealed(state: GameState, list: readonly StrikeStatus[]): boolean {
  if (state.phase !== 'playing') return false;
  return gameSeconds(state) >= 90 || list.some((s) => s.allowed && (s.started || s.state !== 'locked'));
}

// ------------------------------------------------------------------------------------------------ modes

/** The target mode a strike aims with (the launch site is picked at the click: -1). */
export function modeFor(id: StrikeId): TargetMode {
  switch (id) {
    case 'barrage':
      return { kind: 'barrage' };
    case 'bomb':
      return { kind: 'bomb', airfield: -1 };
    case 'paradrop':
      return { kind: 'paradrop', airfield: -1 };
    case 'rocket':
      return { kind: 'missile', silo: -1, missile: 'rocket' };
    case 'atomBomb':
      return { kind: 'missile', silo: -1, missile: 'atomBomb' };
  }
}

/** The strike a target mode belongs to, or null (build, transport, warship). */
export function strikeOfMode(m: TargetMode): StrikeId | null {
  if (m.kind === 'barrage') return 'barrage';
  if (m.kind === 'bomb') return 'bomb';
  if (m.kind === 'paradrop') return 'paradrop';
  if (m.kind === 'missile') return m.missile;
  return null;
}

/** The line at the top of the screen while aiming (ends with how to cancel). */
export function instruction(state: GameState, me: Player, m: TargetMode): string {
  const id = strikeOfMode(m);
  if (!id) return '';
  const tail = ' Esc to cancel.';
  switch (id) {
    case 'barrage':
      return `Barrage: click enemy land within ${barrageRange(me)} tiles of your border.${tail}`;
    case 'bomb':
      return `Bombing run: click enemy land. Bombs hit ${BOMBER_RADIUS} tiles around.${tail}`;
    case 'paradrop':
      return `Paratroopers: click enemy or empty land inside a gold ring.${tail}`;
    case 'rocket':
      return `Rocket: click enemy land anywhere on the map.${tail}`;
    case 'atomBomb':
      return `Atom bomb: click a target. It hits all within ${ATOM_RADIUS} tiles, yours too.${tail}`;
  }
}

/** Enters a strike's target mode when it is ready; otherwise returns the line that says why not ('' = entered). */
export function aimStrike(state: GameState, me: Player, ui: UiState, id: StrikeId): string {
  const s = strikeStatus(state, me, id);
  if (!s.allowed) return `${STRIKES[id].name}: off in this game`;
  if (s.state !== 'ready') return s.line;
  const cur = strikeOfMode(ui.mode);
  ui.contextMenu = null;
  ui.mode = cur === id ? { kind: 'none' } : modeFor(id);
  return '';
}

// ------------------------------------------------------------------------------------------------ targets

export interface StrikeTarget {
  ok: boolean;
  /** why not (ok false), else '' */
  reason: string;
  /** launch site: airfield / silo tile (-1 none or not needed) */
  from: number;
  /** troops a paradrop would send */
  troops: number;
  /** what the blast would hit (bomb, rocket, atom, barrage) */
  enemyTiles: number;
  enemyBuildings: number;
  ownTiles: number;
  ownBuildings: number;
  /** the main nation hit (-1 none) */
  victim: number;
  /** a SAM site or fighters cover the route or target (planes and missiles only) */
  covered: string;
}

function hostileTo(state: GameState, me: number, o: number): boolean {
  return o > 0 && o !== me && !areAllied(state, me, o);
}

function blast(state: GameState, me: number, tile: number, r: number, t: StrikeTarget, everyone: boolean): void {
  const owner = state.map.owner;
  const per = new Map<number, number>();
  forEachInRadius(state.map, tile, r, (i) => {
    const o = owner[i];
    if (o === me) t.ownTiles++;
    else if (hostileTo(state, me, o)) {
      t.enemyTiles++;
      per.set(o, (per.get(o) ?? 0) + 1);
    }
    const b = state.map.building[i] ? buildingAt(state, i) : undefined;
    if (!b) return;
    if (b.owner === me) {
      if (everyone) t.ownBuildings++;
    } else if (everyone || hostileTo(state, me, b.owner)) t.enemyBuildings++;
  });
  let best = 0;
  for (const [o, n] of per) {
    if (n > best) {
      best = n;
      t.victim = o;
    }
  }
}

/** First hostile SAM site (or fighter airfield, for planes) covering the straight route from `from` to `to`, as text. */
function coverOnRoute(state: GameState, me: number, from: number, to: number, planes: boolean): string {
  const w = state.map.width;
  const fx = from >= 0 ? from % w : to % w;
  const fy = from >= 0 ? (from / w) | 0 : (to / w) | 0;
  const tx = to % w;
  const ty = (to / w) | 0;
  const len = Math.hypot(tx - fx, ty - fy);
  const steps = Math.max(1, Math.ceil(len / 4));
  const near = (b: Building, r: number): boolean => {
    const bx = b.tile % w;
    const by = (b.tile / w) | 0;
    for (let k = 0; k <= steps; k++) {
      const x = fx + ((tx - fx) * k) / steps;
      const y = fy + ((ty - fy) * k) / steps;
      if ((x - bx) ** 2 + (y - by) ** 2 <= r * r) return true;
    }
    return false;
  };
  for (const b of state.buildings.values()) {
    if (b.buildLeft > 0 || !hostileTo(state, me, b.owner)) continue;
    if (b.type === 'sam' && !isDisabled(state, b) && near(b, samRadius(b))) return `${state.players[b.owner].name}'s SAM site covers the route: it may be shot down`;
    if (planes && b.type === 'airfield' && b.fighters > 0 && near(b, airfieldRadius(b))) return `${state.players[b.owner].name}'s fighters cover the route: it may be shot down`;
  }
  return '';
}

function d2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

/** Why the sim would refuse a bomb or missile on `tile` because of who owns it ('' = fine). */
function ownerReason(state: GameState, me: number, tile: number, missile: boolean): string {
  const o = state.map.owner[tile];
  if (o === me) return 'That is your own land';
  if (o === 0) return missile ? '' : 'Nobody to bomb there';
  if (!state.players[o]?.alive) return 'That nation is gone';
  if (areAllied(state, me, o)) return missile ? 'You cannot fire at an ally' : 'You cannot bomb an ally';
  return peaceReason(state, me, o) ?? '';
}

/** What a click with this target mode on `tile` would do. */
export function strikeTarget(state: GameState, me: Player, ui: UiState, m: TargetMode, tile: number): StrikeTarget {
  const t: StrikeTarget = { ok: false, reason: '', from: -1, troops: 0, enemyTiles: 0, enemyBuildings: 0, ownTiles: 0, ownBuildings: 0, victim: -1, covered: '' };
  const map = state.map;
  if (tile < 0 || tile >= map.owner.length) return { ...t, reason: 'Pick a tile on the map' };
  const w = map.width;
  const id = strikeOfMode(m);
  if (!id) return t;
  if (m.kind === 'barrage') {
    const why = barrageCheck(state, me.id, tile);
    blast(state, me.id, tile, barrageRadius(state, me.id), t, false);
    return { ...t, ok: why === '', reason: why };
  }
  if (m.kind === 'paradrop') {
    const plan = planParadrop(state, me, ui, tile, m.airfield);
    t.from = plan.airfield;
    t.troops = plan.troops;
    if (!plan.reason && plan.airfield >= 0) t.covered = coverOnRoute(state, me.id, plan.airfield, tile, true);
    return { ...t, ok: plan.reason === '', reason: plan.reason };
  }
  if (m.kind === 'bomb') {
    let from = m.airfield;
    if (from < 0) {
      const ready = airfieldsNear(state, me.id, tile).filter((b) => b.bombers > 0);
      from = ready.length ? ready[0].tile : -1;
    }
    t.from = from;
    const b = from >= 0 ? buildingAt(state, from) : undefined;
    let why = '';
    if (!b || b.owner !== me.id || b.type !== 'airfield' || b.buildLeft > 0) why = 'Bombers fly from a finished Airfield of yours';
    else if (b.bombers < 1) why = 'No bombers at this airfield';
    else why = ownerReason(state, me.id, tile, false);
    blast(state, me.id, tile, BOMBER_RADIUS, t, false);
    if (!why && t.enemyTiles === 0) why = 'Nothing of the enemy to hit there';
    if (!why) t.covered = coverOnRoute(state, me.id, from, tile, true);
    return { ...t, ok: why === '', reason: why };
  }
  // missiles
  const kind = m.kind === 'missile' ? m.missile : 'rocket';
  let from = m.kind === 'missile' ? m.silo : -1;
  if (from < 0) {
    const silos = buildingsOf(state, me.id, 'silo')
      .filter((b) => b.buildLeft <= 0 && chargesReady(b) > 0)
      .sort((a, b) => d2(w, a.tile, tile) - d2(w, b.tile, tile));
    from = silos.length ? silos[0].tile : -1;
  }
  t.from = from;
  const silo = from >= 0 ? buildingAt(state, from) : undefined;
  let why = '';
  if (!silo || silo.owner !== me.id || silo.type !== 'silo' || silo.buildLeft > 0) why = 'All your silos are reloading';
  else if (chargesReady(silo) < 1) why = `The silo is reloading (${Math.ceil(nextChargeIn(silo))} s)`;
  else why = ownerReason(state, me.id, tile, true) || payLine(me, kind);
  blast(state, me.id, tile, kind === 'atomBomb' ? ATOM_RADIUS : ROCKET_RADIUS, t, kind === 'atomBomb');
  if (!why && t.enemyTiles === 0) why = 'Nothing of the enemy to hit there';
  if (!why) t.covered = coverOnRoute(state, me.id, from, tile, false);
  return { ...t, ok: why === '', reason: why };
}


/** The action a click sends for a checked target (null when the target is not ok). */
export function strikeAction(m: TargetMode, tile: number, t: StrikeTarget): Action | null {
  if (!t.ok) return null;
  switch (m.kind) {
    case 'barrage':
      return { type: 'barrage', tile };
    case 'paradrop':
      return { type: 'paradrop', airfield: t.from, tile, troops: t.troops };
    case 'bomb':
      return { type: 'bomb', airfield: t.from, tile };
    case 'missile':
      return { type: 'launchMissile', silo: t.from, kind: m.missile, tile };
    default:
      return null;
  }
}

/** One short line on what the strike would hit there ("Hits 3 buildings and 120 tiles of Ardania"). */
export function blastSummary(state: GameState, m: TargetMode, t: StrikeTarget): string {
  const victim = t.victim > 0 ? state.players[t.victim]?.name ?? 'the enemy' : 'the enemy';
  if (m.kind === 'paradrop') return `${formatCount(t.troops)} infantry land and attack from here`;
  const parts: string[] = [];
  if (t.enemyBuildings) parts.push(`${t.enemyBuildings} building${t.enemyBuildings === 1 ? '' : 's'}`);
  parts.push(`${formatCount(t.enemyTiles)} tiles of ${victim}`);
  let s = `Hits ${parts.join(' and ')}`;
  if (m.kind === 'barrage') s += `. Lands in ${BARRAGE_DELAY} s`;
  return s;
}

/** Atom bomb only: what of your own the blast would hit ('' = nothing). */
export function ownHitWarning(m: TargetMode, t: StrikeTarget): string {
  if (m.kind !== 'missile' || m.missile !== 'atomBomb' || (!t.ownTiles && !t.ownBuildings)) return '';
  return `Also hits ${formatCount(t.ownTiles)} of your tiles${t.ownBuildings ? ` and ${t.ownBuildings} of your buildings` : ''}`;
}

// ------------------------------------------------------------------------------------------------ barrage reach

export interface ReachMask {
  /** cells per row / column */
  cw: number;
  ch: number;
  /** tiles per cell side */
  cell: number;
  /** 1 = a barrage can reach this cell (within range of your land) */
  inside: Uint8Array;
}

/**
 * Tiles a barrage can reach: within `range` of the player's land. Computed on a coarse grid (cells of 1, 2 or 4 tiles
 * so a big map stays cheap) with a 5-7-11 chamfer distance (within ~2% of the straight-line distance). For the
 * shaded zone only: the click itself is checked exactly by the sim's canBarrage.
 */
export function barrageReach(state: GameState, playerId: number, range: number): ReachMask {
  const { width: w, height: h, owner } = state.map;
  const cell = w * h > 600_000 ? 4 : w * h > 150_000 ? 2 : 1;
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const n = cw * ch;
  const INF = 1 << 29;
  const d = new Int32Array(n).fill(INF);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const cr = ((y / cell) | 0) * cw;
    for (let x = 0; x < w; x++) if (owner[row + x] === playerId) d[cr + ((x / cell) | 0)] = 0;
  }
  // 5-7-11 chamfer: forward then backward pass
  const fwd: [number, number, number][] = [
    [-1, 0, 5], [0, -1, 5], [-1, -1, 7], [1, -1, 7],
    [-2, -1, 11], [-1, -2, 11], [1, -2, 11], [2, -1, 11],
  ];
  const pass = (dirs: [number, number, number][], sign: 1 | -1): void => {
    const y0 = sign > 0 ? 0 : ch - 1;
    const y1 = sign > 0 ? ch : -1;
    const x0 = sign > 0 ? 0 : cw - 1;
    const x1 = sign > 0 ? cw : -1;
    for (let y = y0; y !== y1; y += sign) {
      for (let x = x0; x !== x1; x += sign) {
        const i = y * cw + x;
        let v = d[i];
        if (v === 0) continue;
        for (const [dx, dy, c] of dirs) {
          const nx = x + dx * sign;
          const ny = y + dy * sign;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const u = d[ny * cw + nx] + c;
          if (u < v) v = u;
        }
        d[i] = v;
      }
    }
  };
  pass(fwd, 1);
  pass(fwd, -1);
  const inside = new Uint8Array(n);
  // distance in tiles = d / 5 * cell; allow half a cell of slack so the edge cells are not cut short
  const lim = ((range + cell * 0.5) / cell) * 5;
  for (let i = 0; i < n; i++) inside[i] = d[i] <= lim ? 1 : 0;
  return { cw, ch, cell, inside };
}

// ------------------------------------------------------------------------------------------------ toasts

/**
 * Toast text for strike events: our own read as a short report ("Barrage on Ardania: 1.2k troops lost, a fort or
 * SAM site silenced for 20 s"), strikes on us as a warning, and planes or missiles shot down name who did it.
 * null = not a strike event (the usual toast rules apply).
 */
export function strikeToastText(e: GameEvent, me: Player): { text: string; kind: 'good' | 'bad' | 'info' | 'warn'; icon: string } | null {
  const m = e.message;
  const n = me.name;
  const after = (prefix: string): string | null => (m.startsWith(prefix) ? m.slice(prefix.length) : null);
  let r: string | null;
  switch (e.kind) {
    case 'barrage':
      if ((r = after(`${n}'s artillery is shelling `)) !== null) return { text: `Shells on the way to ${r}: they land in ${BARRAGE_DELAY} s`, kind: 'info', icon: 'barrage' };
      if ((r = after(`${n} shelled `)) !== null) return { text: `Barrage on ${r.replace(' troops lost', ' troops killed')}`, kind: 'good', icon: 'barrage' };
      return { text: m, kind: 'bad', icon: 'barrage' };
    case 'bombing':
      if ((r = after(`${n} bombed `)) !== null) return { text: `Bombing run on ${r}`, kind: 'good', icon: 'bomb' };
      return { text: m, kind: 'bad', icon: 'bomb' };
    case 'missile': {
      const atom = / an atom bomb /.test(m);
      if ((r = after(`${n} launched `)) !== null) return { text: `${atom ? 'Atom bomb' : 'Rocket'} on its way to ${r.replace(/^(a rocket|an atom bomb) at /, '')}`, kind: 'info', icon: atom ? 'atom' : 'rocket' };
      if ((r = after(`Rocket strike by ${n}: `)) !== null) return { text: `Rocket hit: ${r}`, kind: 'good', icon: 'rocket' };
      return { text: m, kind: 'bad', icon: atom ? 'atom' : 'rocket' };
    }
    case 'nuke':
      if ((r = after(`${n} dropped an atom bomb`)) !== null) return { text: `Atom bomb${r}`, kind: 'good', icon: 'atom' };
      return { text: m, kind: 'bad', icon: 'atom' };
    case 'paradrop':
      if ((r = after(`${n} is dropping `)) !== null) return { text: `Dropping ${r}`, kind: 'info', icon: 'paradrop' };
      if ((r = after(`${n}'s paratroopers landed in `)) !== null) return { text: `Your paratroopers landed in ${r}`, kind: 'good', icon: 'paradrop' };
      return { text: m, kind: 'bad', icon: 'paradrop' };
    case 'unitLost': {
      const shot = /^(.*)'s (SAM site|fighters) shot down an? (.+?) of (.+)$/.exec(m);
      if (shot) {
        const [, by, what, unit, owner] = shot;
        const icon = /bomber/.test(unit) ? 'bomb' : /rocket/.test(unit) ? 'rocket' : /atom/.test(unit) ? 'atom' : 'paradrop';
        if (owner === n) return { text: `${by}'s ${what} shot down your ${unit}`, kind: 'bad', icon };
        if (by === n) return { text: `Your ${what} shot down ${owner}'s ${unit}`, kind: 'good', icon };
      }
      if ((r = after(`${n}'s paratroopers were wiped out`)) !== null) return { text: `Your paratroopers were wiped out${r}`, kind: 'bad', icon: 'paradrop' };
      return null;
    }
    default:
      return null;
  }
}
