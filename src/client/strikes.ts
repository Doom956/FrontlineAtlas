// Special strikes on the client: artillery barrage, bombing run, paratroopers, rocket and atom bomb.
// One place answers, for the command bar, the hotkeys, the radial menu, the advisor and the map preview:
//   - strikeStatus(): ready / cooling down / locked (with the one line that says how to unlock it) / blocked
//   - modeFor() / strikeOfMode(): the target mode a strike uses
//   - strikeTarget(): what a click on a tile would do (the launch site picked, or why not) and what the blast hits
//   - instruction(): the line at the top of the screen while aiming
//   - barrageReach(): which tiles a barrage can reach (the shaded zone while aiming)
// The rules stay in the sim (canBarrage, canParadrop, launchBomber, launchMissile); this file only phrases them and
// checks a click before it is sent, so a wasted strike shows its reason at the cursor instead.
import { artilleryOf, barrageCooldown, barrageRadius, barrageRange, barrageReadyIn, ownLandWithin } from '../sim/barrage';
import { noMissileReason } from '../sim/airstrike';
import { activeFog, nationName, type FogView } from './fog/fogView';
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
import { buildingAllowed, peaceActive, unitAllowed } from '../sim/rules';
import { gameSeconds } from '../sim/state';
import { unitCost } from '../sim/units';
import { hasTech } from '../sim/tech';
import type { Action, Building, GameEvent, GameState, Player, UnitType } from '../sim/types';
import type { IconId } from './icons';
import { formatCount } from './render/common';
import { bombReach, bomberRadiusOf, previewStrike, salvoAction, salvoLabel, type SalvoKind, type SalvoSize } from './airSim';
import { barrageCheck, paradropRange, planParadrop } from './simx';
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
    what: `Bombers wreck buildings and kill troops within ${BOMBER_RADIUS} tiles (more with Strategic Bombing), then fly home. Your Air path counts: Heavy Bombers hit harder, Ground-attack planes hit troops at the front harder.`,
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

const lockedFlight = 'Buy Flight in the Arsenal (T), then build an Airfield';

/** A radius for text: whole tiles, one decimal when it has one (Night Bombing 4.3). */
export function fmtR(r: number): string {
  const v = Math.round(r * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** The salvo kind a strike fires with (bomb, rocket, atom bomb), or null (barrage, paratroopers). */
export function salvoKindOf(id: StrikeId | null): SalvoKind | null {
  return id === 'bomb' || id === 'rocket' || id === 'atomBomb' ? id : null;
}

/** The salvo size picked for this strike (x1 when none is set). */
export function salvoOf(ui: Pick<UiState, 'salvo'> | undefined, kind: SalvoKind): SalvoSize {
  const v = ui?.salvo?.[kind];
  return v === 1 || v === 3 || v === 5 || v === 0 ? v : 1;
}

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
      if (stored > 0) return { ...st, line: `${stored} bomber${stored === 1 ? '' : 's'} ready. Click enemy land: bombs hit ${fmtR(bomberRadiusOf(state, me.id))} tiles around.` };
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
export function instruction(state: GameState, me: Player, m: TargetMode, ui?: Pick<UiState, 'salvo'>): string {
  const id = strikeOfMode(m);
  if (!id) return '';
  const tail = ' Esc to cancel.';
  switch (id) {
    case 'barrage':
      return `Barrage: click enemy land within ${barrageRange(me)} tiles of your border.${tail}`;
    case 'bomb':
      return `Bombing run ${salvoLabel(salvoOf(ui, 'bomb'))}: click enemy land.${tail}`;
    case 'paradrop':
      return `Paratroopers: click enemy or empty land inside a gold ring.${tail}`;
    case 'rocket':
      return `Rocket ${salvoLabel(salvoOf(ui, 'rocket'))}: click enemy land anywhere on the map.${tail}`;
    case 'atomBomb':
      return `Atom bomb ${salvoLabel(salvoOf(ui, 'atomBomb'))}: click a target. It hits all within ${ATOM_RADIUS} tiles, yours too.${tail}`;
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
  /** bombs and missiles: how many fly with this click (the salvo), how many are ready in reach, from how many sites */
  count: number;
  ready: number;
  sites: number;
  /** the launch sites that fly (airfield / silo tiles, first = `from`) */
  siteTiles: number[];
  /** the salvo picked (x1 / x3 / x5 / All = 0) */
  size: SalvoSize;
  /** bombs: 'support' (a front strike, aimed ahead of your push) or 'raid'; missiles: their kind; '' = not a bomb or missile */
  role: string;
  /** where it aims (a front strike leads the push: may differ from the clicked tile; -1 = the click) */
  aim: number;
  /** fog of war: part of the target is out of view, so what it would hit is not shown (the counts are 0) */
  blind: boolean;
  /** blast radius (tiles) and the expected result of the whole salvo (airstrike.strikePreview) */
  radius: number;
  kills: number;
  wrecks: number;
  /** support: defence cut in the zone and how long it lasts (s); raid: income cut and seconds; Strategic Bombing gold burnt */
  zoneCut: number;
  zoneSeconds: number;
  incomeCut: number;
  raidSeconds: number;
  burn: number;
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
  // fog of war: only SAM sites and airfields this player sees or remembers
  const fog = activeFog(state);
  for (const b of state.buildings.values()) {
    if (b.buildLeft > 0 || !hostileTo(state, me, b.owner)) continue;
    if (fog && fog.buildingAt(state, b.tile)?.type !== b.type) continue;
    if (b.type === 'sam' && !isDisabled(state, b) && near(b, samRadius(b))) return `${nationName(state, b.owner)}'s SAM site covers the route: it may be shot down`;
    if (planes && b.type === 'airfield' && b.fighters > 0 && near(b, airfieldRadius(b))) return `${nationName(state, b.owner)}'s fighters cover the route: it may be shot down`;
  }
  return '';
}



/**
 * What a click with this target mode on `tile` would do. Fog of war: judged by what this player knows (fogStrike), so
 * sweeping the cursor over dark land tells nothing about who holds it.
 */
export function strikeTarget(state: GameState, me: Player, ui: UiState, m: TargetMode, tile: number): StrikeTarget {
  const t = liveStrikeTarget(state, me, ui, m, tile);
  const fog = activeFog(state);
  return fog && tile >= 0 && tile < state.map.owner.length ? fogStrike(state, fog, me, m, tile, t) : t;
}

/** The sim's answers that depend on who holds the target (they must not show through fog). */
const OWNER_REASONS = new Set([
  'That is your own land',
  'Nobody to bomb there',
  'Nobody to shell there',
  'Nothing of the enemy to hit there',
  'That nation is gone',
  'You cannot bomb an ally',
  'You cannot fire at an ally',
  'You cannot shell an ally',
  'You cannot attack an ally',
]);
function ownerReason(why: string): boolean {
  return OWNER_REASONS.has(why) || why.startsWith('Peace time:');
}

/**
 * Fog of war: a strike target as this player may know it. Land out of view counts by its last seen owner: a strike
 * needs enemy land you have seen there (bombs and barrages: the tile itself; rockets and atom bombs: anywhere in the
 * blast), and the sim's answers about the real owner are replaced by the ones the launch sites give (reach, reload,
 * gold). What a blast would hit is not counted when part of it is out of view (`blind`). A click can still fail when
 * the land changed while out of sight: the sim decides with the real owner, like an attack.
 */
function fogStrike(state: GameState, fog: FogView, me: Player, m: TargetMode, tile: number, t: StrikeTarget): StrikeTarget {
  const id = strikeOfMode(m);
  if (!id) return t;
  const hiddenClick = !fog.visible(tile);
  const hostile = (k: number): boolean => k > 0 && k !== me.id && !!state.players[k]?.alive && !areAllied(state, me.id, k);
  // blast area: anything out of view, any enemy land known there
  const aim = t.aim >= 0 ? t.aim : tile;
  const r = id === 'barrage' ? barrageRadius(state, me.id) : t.radius;
  let hidden = hiddenClick;
  let known = false;
  if (id !== 'paradrop' && r > 0) {
    forEachInRadius(state.map, aim, r, (i) => {
      if (!fog.visible(i)) hidden = true;
      if (!known && hostile(fog.knownOwner(state, i))) known = true;
    });
  } else known = hostile(fog.knownOwner(state, aim));
  const out: StrikeTarget = hidden ? { ...t, blind: true, enemyTiles: 0, enemyBuildings: 0, victim: -1, kills: 0, wrecks: 0, zoneCut: 0, incomeCut: 0, burn: 0, covered: hiddenClick ? '' : t.covered } : t;
  if (!hidden) return t;
  const no = (reason: string): StrikeTarget => ({ ...out, ok: false, reason });
  if (hiddenClick && peaceActive(state)) return no('Peace time: strike only where you can see who holds the land');
  if (id === 'paradrop') return out; // hidden land is never your own or an ally's: the drop only needs land
  const unseen = !fog.explored(tile);
  const tileFoe = hostile(fog.knownOwner(state, tile));
  if ((id === 'bomb' || id === 'barrage') && !tileFoe) {
    return no(unseen ? 'Unexplored: you have not seen enemy land there' : id === 'bomb' ? 'Last seen: nobody to bomb there' : 'Last seen: nobody to shell there');
  }
  if (!known) return no(unseen ? 'Unexplored: you have not seen enemy land there' : 'Last seen: nothing of the enemy there');
  if (t.ok || !ownerReason(t.reason)) return out;
  // the sim said no because of who holds it now: say what the launch sites say instead
  if (id === 'barrage') {
    const range = barrageRange(me);
    if (!ownLandWithin(state, me.id, tile, range)) return no(`Too far: guns reach ${range} tiles from your border`);
    if (me.gold < BARRAGE_GOLD) return no(`Not enough gold (${BARRAGE_GOLD})`);
    return { ...out, ok: true, reason: '' };
  }
  if (t.count > 0) return { ...out, ok: true, reason: '' };
  if (id === 'bomb') {
    const fixed = m.kind === 'bomb' ? m.airfield : -1;
    return no(fixed >= 0 ? 'No bombers at this airfield (or out of its reach)' : tooFar(state, me.id, tile) || 'No airfield with bombers reaches that far');
  }
  return no(noMissileReason(state, me.id, id === 'atomBomb' ? 'atomBomb' : 'rocket', m.kind === 'missile' ? m.silo : -1));
}

/** What a click would do, by the live state (strikeTarget applies fog of war on top). */
function liveStrikeTarget(state: GameState, me: Player, ui: UiState, m: TargetMode, tile: number): StrikeTarget {
  const t: StrikeTarget = {
    ok: false, reason: '', from: -1, troops: 0, enemyTiles: 0, enemyBuildings: 0, ownTiles: 0, ownBuildings: 0, victim: -1, covered: '',
    count: 0, ready: 0, sites: 0, siteTiles: [], size: 1, role: '', aim: -1, blind: false, radius: 0, kills: 0, wrecks: 0, zoneCut: 0, zoneSeconds: 0, incomeCut: 0, raidSeconds: 0, burn: 0,
  };
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
  const kind: SalvoKind = m.kind === 'bomb' ? 'bomb' : m.kind === 'missile' ? m.missile : 'rocket';
  const fixed = m.kind === 'bomb' ? m.airfield : m.kind === 'missile' ? m.silo : -1;
  const size = salvoOf(ui, kind);
  // the sim's own preview (airstrike.strikePreview): who flies, where it aims and what it does
  const { pv, ready } = previewStrike(state, me.id, kind, tile, size, fixed);
  t.size = size;
  t.ready = ready;
  t.count = pv.launchers;
  t.sites = pv.sites.length;
  t.siteTiles = pv.sites;
  t.from = pv.sites.length ? pv.sites[0] : -1;
  t.role = pv.role;
  t.aim = pv.aim;
  t.radius = pv.radius;
  t.kills = pv.kills;
  t.wrecks = pv.buildingsHit;
  t.zoneCut = pv.zoneCut;
  t.zoneSeconds = pv.zoneSeconds;
  t.incomeCut = pv.raidCut;
  t.raidSeconds = pv.raidSeconds;
  t.burn = pv.goldBurn;
  t.victim = pv.victim > 0 ? pv.victim : -1;
  t.enemyTiles = pv.enemyTiles;
  t.enemyBuildings = pv.enemyBuildings;
  t.ownTiles = pv.ownTiles;
  t.ownBuildings = pv.ownBuildings;
  let why = pv.reason;
  if (kind === 'bomb' && !pv.launchers && fixed < 0) why = tooFar(state, me.id, tile) || why;
  if (!why) t.covered = coverOnRoute(state, me.id, t.from, t.aim >= 0 ? t.aim : tile, kind === 'bomb');
  return { ...t, ok: why === '', reason: why };
}

/** Bombers stored but none in reach of tile: "Too far: your bombers reach 60 tiles, this is 85 away" ('' = not that). */
function tooFar(state: GameState, pid: number, tile: number): string {
  const w = state.map.width;
  let best = '';
  let gap = Infinity;
  for (const b of buildingsOf(state, pid, 'airfield')) {
    if (b.buildLeft > 0 || b.bombers < 1) continue;
    const d = Math.hypot((b.tile % w) - (tile % w), ((b.tile / w) | 0) - ((tile / w) | 0));
    const r = bombReach(state, b);
    if (d <= r) return '';
    if (d - r < gap) {
      gap = d - r;
      best = `Too far: your nearest bombers reach ${Math.round(r)} tiles, this is ${Math.round(d)} away (the gold rings)`;
    }
  }
  return best;
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
      return salvoAction('bomb', t.from, tile, t.size, m.airfield);
    case 'missile':
      return salvoAction(m.missile, t.from, tile, t.size, m.silo);
    default:
      return null;
  }
}

/** One short line on what the strike would hit there ("3 bombers from 2 airfields: ~16k troops, 2 buildings of Ardania"). */
export function blastSummary(state: GameState, m: TargetMode, t: StrikeTarget): string {
  const victim = t.victim > 0 ? state.players[t.victim]?.name ?? 'the enemy' : 'the enemy';
  if (m.kind === 'paradrop') return `${formatCount(t.troops)} infantry land and attack from here`;
  if (m.kind === 'barrage') {
    const parts: string[] = [];
    if (t.enemyBuildings) parts.push(`${t.enemyBuildings} building${t.enemyBuildings === 1 ? '' : 's'}`);
    parts.push(`${formatCount(t.enemyTiles)} tiles of ${victim}`);
    return `Hits ${parts.join(' and ')}. Lands in ${BARRAGE_DELAY} s`;
  }
  return `${salvoHead(m, t)}: ${effectText(m, t, victim)}`;
}

/** "3 bombers from 2 airfields" / "1 rocket" / "2 rockets from 2 silos (3 more not ready)". */
export function salvoHead(m: TargetMode, t: StrikeTarget): string {
  const unit = m.kind === 'bomb' ? 'bomber' : m.kind === 'missile' && m.missile === 'atomBomb' ? 'atom bomb' : 'rocket';
  const n = Math.max(1, t.count);
  return `${n} ${unit}${n === 1 ? '' : 's'}${salvoDetail(m, t)}`;
}

/** " from 2 airfields (3 more not ready)" ('' for one site and a full salvo). */
export function salvoDetail(m: TargetMode, t: StrikeTarget): string {
  const n = Math.max(1, t.count);
  const want = t.size === 0 ? t.ready : t.size;
  const site = m.kind === 'bomb' ? 'airfield' : 'silo';
  let s = t.sites > 1 ? ` from ${t.sites} ${site}s` : '';
  if (want > n) s += ` (${want - n} more not ready${m.kind === 'missile' && t.ready >= want ? ' or not paid for' : m.kind === 'bomb' ? ' or out of reach' : ''})`;
  return s;
}

/** The tooltip body under "Send 3 bombers here": where they fly from (when it says more) and what they hit. */
export function strikeBody(state: GameState, m: TargetMode, t: StrikeTarget): string {
  if (m.kind !== 'bomb' && m.kind !== 'missile') return blastSummary(state, m, t);
  const victim = t.victim > 0 ? state.players[t.victim]?.name ?? 'the enemy' : 'the enemy';
  const d = salvoDetail(m, t).trim();
  const e = effectText(m, t, victim);
  return d ? `${d.charAt(0).toUpperCase()}${d.slice(1)}: ${e}` : `${e.charAt(0).toUpperCase()}${e.slice(1)}`;
}

function effectText(m: TargetMode, t: StrikeTarget, victim: string): string {
  const atom = m.kind === 'missile' && m.missile === 'atomBomb';
  const parts: string[] = [];
  if (t.kills >= 1) parts.push(`~${formatCount(t.kills)} troops`);
  const wrecks = atom ? t.enemyBuildings : Math.round(t.wrecks);
  if (wrecks > 0) parts.push(`~${wrecks} building${wrecks === 1 ? '' : 's'}`);
  if (atom || !parts.length) parts.push(`${formatCount(t.enemyTiles)} tiles`);
  let s = `${parts.join(', ')} of ${victim} within ${fmtR(t.radius)} tiles`;
  if (t.zoneCut > 0) s += `; their defence there −${Math.round(t.zoneCut * 100)}% for ${Math.round(t.zoneSeconds)} s`;
  if (t.incomeCut > 0) s += `; their income −${Math.round(t.incomeCut * 100)}% for ${Math.round(t.raidSeconds)} s`;
  if (t.burn >= 1) s += `; ${formatCount(t.burn)} gold burnt`;
  return s;
}

/** Bombs: what kind of strike this click is ("Front strike, aimed ahead of your push" / "Raid"); '' for missiles. */
export function strikeRoleLine(state: GameState, t: StrikeTarget, tile: number): string {
  if (t.role === 'support') {
    if (t.aim >= 0 && t.aim !== tile) {
      const w = state.map.width;
      const d = Math.round(Math.hypot((t.aim % w) - (tile % w), ((t.aim / w) | 0) - ((tile / w) | 0)));
      if (d >= 2) return `Front strike: aims ${d} tiles ahead, where your push will be when they arrive`;
    }
    return 'Front strike: cuts their defence for your push';
  }
  if (t.role === 'raid') return 'Raid: wrecks buildings and cuts their income';
  return '';
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
