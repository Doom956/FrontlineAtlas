// Arsenal Defense row (arsenal.ts row 'defense'; numbers in config DEFENSE). No buildings of its own: it arms the
// nation's Forts and Cities. Every item needs Fortification (Research tab) and a finished own Fort to order.
//
// Flak Guns (fork root of the anti-air lane):
//   - SITES: every finished, working own Fort (radius DEFENSE.flakFortRadius, + per level) and City (flakCityRadius,
//     + per level) of a Flak Guns holder. A site is working while no barrage or support strike has knocked it out
//     (Building.disabledUntil). Sites live in a cached grid (rebuilt when a building or the set of holders changes).
//   - WEAR: every DEFENSE.flakCheckTicks ticks each hostile bomber, ground-attack plane, cargo plane or stealth bomber
//     flying OUT (state 0) adds wear (Unit.flakWear, hashed) = tiles flown since the last check x the sum of the
//     rates of the strongest flakMaxZones hostile sites holding it (flakWearPerTile + flakWearPerLevel x (level - 1)),
//     x the plane's factor (ground-attack x1.3, heavy x0.7, stealth x1: flak is not radar aimed). The segment flown is
//     sampled every tile along the straight line from home, so a fast plane can't skip a zone between checks; a plane
//     over its aim between checks adds the stretch since the last one (it releases: no abort then).
//   - ABORT: at flakAbortAt or more before release the plane turns home with its bombs (a cargo plane brings the
//     troops back).
//   - CUT: on arrival the strike's kills, zone strength, raid cut, buildings hit and gold burn are x (1 - wear), then x
//     the air superiority cut, never below flakEffectFloor of normal (flakCut; units.dropBombs, airwings.supportStrike /
//     raid). Paratroopers landing: x (1 - wear), the rest are lost.
//   - Rockets, cruise missiles, atom bombs and recon planes are ignored. Interception (SAMs, fighters, carriers, patrols)
//     runs after the flak check and is unchanged.
// Tank Traps (fork root of the barriers lane):
//   - A trap tile is own land of a Tank Traps holder within trapReach (the fort's radius + trapBelt) of a finished,
//     working own Fort. Strength 1 on dug land (trench level >= trapMinTrench), trapPlain on undug land (trapStrength).
//     Derived, never stored (trenches and forts are hashed already); barrages and atom bombs flatten the trench (the
//     traps there drop to trapPlain), a knocked-out fort lays none. Why the belt: a fort's own radius already stops a
//     spearhead without artillery, so the AI never drove into it and traps that needed it plus a trench slowed 1% of
//     spearheads; the belt meets spearheads on the open land around the forts.
//   - A hostile spearhead head on a trap tile moves at trapHeadSpeed of its speed (x strength), and the division loses
//     trapLossPerTile (x strength) of its start strength per trap tile taken, at most trapMaxLoss per spearhead (Unit.trapLoss,
//     hashed). Light tanks x1.3, heavy x0.7, Siege Tanks x0; artillery support halves it; a Breakthrough's surge is
//     x trapBlitzSurge there (tanks.ts).
// Tracking Radar (anti-air lane, after Flak Guns; needs Radar):
//   - Every finished, working own SAM site of a holder tracks a hostile stealth bomber inside radarReach x its SAM
//     reach (x Early Warning). Time inside adds up per SAM site and bomber over the whole flight (Unit.radarLock,
//     hashed); from radarLockSeconds on, the bomber is revealed to that side while it is inside a locked circle
//     (Unit.radarSeen, hashed; stealthSight.stealthRevealedTo reads it). Revealed, SAMs and fighters engage it by the
//     bomber rule; it has 2 hp (UNITS.stealthBomber). Shot down, its owner's next one waits STEALTH.lostCooldownSeconds.
//   - Crossing a level-1 circle takes a stealth bomber about 2 s, so a lock mostly comes on its way home past the same
//     radars (near its target the SAM hunter has silenced them): the strike still lands most of the time.
// Coastal Batteries (barriers lane, after Tank Traps):
//   - Sites: finished own Ports and finished Forts within batteryCoast tiles of water. Every batteryFireSeconds
//     (staggered by building id) a working site (not knocked out, hp >= batteryFireHp) fires at one hostile ship of a
//     nation at war with it (naval2.atWar) within batteryRange (+ per level, at most batteryRangeMax < battleship
//     shelling 35): a warship that fired a cruise missile in the last batteryCruiseMemory s, then warships whose
//     shelling reaches the site, then other warships (nearest, then id). Hidden submarines are not seen. Warships
//     lose batteryDamage hp.
//   - Transports (shore fire, every tick): a transport sailing inside the range of a working battery of a nation at war
//     with it, OR of the nation it sails to invade (an invasion needs no war yet: the landing starts it), loses
//     batteryTransportPerTile of its troops per tile sailed there (x (1 + batteryTransportExtra) per further covering
//     battery, at most batteryTransportStack counted), at most batteryTransportMaxLoss per voyage (Unit.shoreLoss,
//     hashed); never sunk. A transport crossing one battery's full reach (~30 tiles) loses about 30%. Why per tile and
//     not per shot: transports sail 10 to 20 tiles/s, so a 2 s gun got one shot (6%) at most, and the war rule let
//     every first landing on a nation through untouched.
//   - Silencing: hostile warships shell batteries first (units.ts updateWarship, shellBatteryTarget: AI ships and a
//     player's auto / bombard ships), taking hp off them (never below batteryHpFloor; no fire under batteryFireHp).
// Part 3 (Counteroffensive) hooks in here.
// Deterministic: state only, no RNG; caches are WeakMaps keyed by the GameState and rebuilt from it.
import { BLITZ, CRUISE, DEFENSE, STEALTH, TICK_SECONDS, TICKS_PER_SECOND, UNITS, WARSHIP_SHELL_RANGE } from './config';
import { buildingsOf, fortRadius, samRadius } from './buildings';
import { areAllied } from './diplomacy';
import { atWar } from './naval2';
import { atPeace } from './rules';
import { earlyWarningMul } from './specials';
import { addEvent } from './state';
import { hasTech } from './tech';
import { techAirSpeedMul, unitVisibleTo } from './techtree';
import { trenchLevel } from './trenches';
import { navalShellMul, navalShellRangeMul } from './variants';
import { isWater, TROOP_TYPES } from './types';
import type { Building, GameState, Unit } from './types';

/** A flak site: a finished Fort or City of a Flak Guns holder. */
export interface FlakSite {
  building: Building;
  owner: number;
  tile: number;
  x: number;
  y: number;
  /** radius (tiles) */
  r: number;
  /** wear per tile flown inside */
  rate: number;
}

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** Flak radius of a Fort or City (0 for other buildings). */
export function flakRadius(b: Building): number {
  if (b.type === 'fort') return DEFENSE.flakFortRadius + DEFENSE.flakFortRadiusPerLevel * (b.level - 1);
  if (b.type === 'city') return DEFENSE.flakCityRadius + DEFENSE.flakCityRadiusPerLevel * (b.level - 1);
  return 0;
}
/** Wear per tile flown inside the zone of site b. */
export function flakRate(b: Building): number {
  return DEFENSE.flakWearPerTile + DEFENSE.flakWearPerLevel * (b.level - 1);
}
/** True while site b fires (finished, not knocked out, not wrecked). */
export function flakWorking(state: GameState, b: Building): boolean {
  return b.buildLeft <= 0 && b.disabledUntil <= state.tick && b.hp > 0;
}
/** True if player pid holds Flak Guns. */
export function hasFlak(state: GameState, pid: number): boolean {
  const p = state.players[pid];
  return !!p && pid > 0 && hasTech(p, 'flakGuns');
}
/** True if building b is a flak site (a finished Fort or City of a Flak Guns holder; working or not). */
export function isFlakSite(state: GameState, b: Building): boolean {
  return (b.type === 'fort' || b.type === 'city') && b.buildLeft <= 0 && hasFlak(state, b.owner);
}
/**
 * The share a strike flying straight to the centre of site b loses there, for a plane with flak factor `factor`
 * (the "-35%" of the cards and rings): radius x rate x factor, at most 1 - flakEffectFloor.
 */
export function flakSiteCut(b: Building, factor = 1): number {
  return Math.min(1 - DEFENSE.flakEffectFloor, flakRadius(b) * flakRate(b) * factor);
}

export interface FlakGrid {
  key: string;
  sites: FlakSite[];
  cols: number;
  rows: number;
  cells: FlakSite[][];
}
const grids = new WeakMap<GameState, FlakGrid>();

function holders(state: GameState): number[] {
  const out: number[] = [];
  for (const p of state.players) if (p.id > 0 && p.alive && hasTech(p, 'flakGuns')) out.push(p.id);
  return out;
}

/**
 * The cached flak site grid (rebuilt when buildings or the holders change); null when nobody holds Flak Guns. The key
 * is checked on every call, so the cache never depends on who asked when (the client reads it too).
 */
function gridOf(state: GameState): FlakGrid | null {
  const hs = holders(state);
  if (!hs.length) return null;
  const key = `${state.buildingsVersion}|${hs.join(',')}`;
  const old = grids.get(state);
  if (old && old.key === key) return old;
  const w = state.map.width;
  const cell = DEFENSE.flakGridCell;
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(state.map.height / cell));
  const cells: FlakSite[][] = [];
  for (let k = 0; k < cols * rows; k++) cells.push([]);
  const sites: FlakSite[] = [];
  for (const pid of hs) {
    for (const type of ['fort', 'city'] as const) {
      for (const b of buildingsOf(state, pid, type)) {
        if (b.buildLeft > 0) continue;
        const s: FlakSite = { building: b, owner: pid, tile: b.tile, x: b.tile % w, y: (b.tile / w) | 0, r: flakRadius(b), rate: flakRate(b) };
        sites.push(s);
        const c0 = Math.max(0, Math.floor((s.x - s.r) / cell));
        const c1 = Math.min(cols - 1, Math.floor((s.x + s.r) / cell));
        const r0 = Math.max(0, Math.floor((s.y - s.r) / cell));
        const r1 = Math.min(rows - 1, Math.floor((s.y + s.r) / cell));
        for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) cells[cy * cols + cx].push(s);
      }
    }
  }
  const g: FlakGrid = { key, sites, cols, rows, cells };
  grids.set(state, g);
  return g;
}

/** All flak sites (finished Forts and Cities of Flak Guns holders, working or not); for the client's rings. */
export function flakSites(state: GameState): readonly FlakSite[] {
  return gridOf(state)?.sites ?? [];
}

const topScratch: FlakSite[] = [];
/**
 * The strongest (at most flakMaxZones) working flak sites hostile to `planeOwner` holding the point (x, y), strongest
 * first (ties by building id). Shared scratch array: copy it to keep it.
 */
export function flakZonesAt(state: GameState, planeOwner: number, x: number, y: number, grid?: FlakGrid | null): readonly FlakSite[] {
  topScratch.length = 0;
  const g = grid === undefined ? gridOf(state) : grid;
  if (!g) return topScratch;
  const cell = DEFENSE.flakGridCell;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return topScratch;
  for (const s of g.cells[cy * g.cols + cx]) {
    const dx = s.x - x;
    const dy = s.y - y;
    if (dx * dx + dy * dy > s.r * s.r) continue;
    if (!hostile(state, planeOwner, s.owner) || !flakWorking(state, s.building)) continue;
    topScratch.push(s);
  }
  if (topScratch.length > 1) topScratch.sort((a, b) => b.rate - a.rate || a.building.id - b.building.id);
  if (topScratch.length > DEFENSE.flakMaxZones) topScratch.length = DEFENSE.flakMaxZones;
  return topScratch;
}

/** Wear per tile at (x, y) for a plane of `planeOwner` (factor 1): the sum of the strongest zones' rates. */
export function flakRateAt(state: GameState, planeOwner: number, x: number, y: number, grid?: FlakGrid | null): number {
  let r = 0;
  for (const s of flakZonesAt(state, planeOwner, x, y, grid)) r += s.rate;
  return r;
}

/** Flak factor of a plane: ground-attack x1.3, heavy bombers x0.7, stealth x1, cargo x1; 0 for anything else. */
export function flakFactor(u: Unit): number {
  if (u.type === 'bomber') return u.variant === 'groundAttack' ? DEFENSE.flakVsGroundAttack : u.variant === 'heavyBomber' ? DEFENSE.flakVsHeavy : 1;
  if (u.type === 'stealthBomber') return DEFENSE.flakVsStealth;
  if (u.type === 'transportPlane') return DEFENSE.flakVsCargo;
  return 0;
}

/**
 * Wear a plane of `owner` with flak factor `factor` would gain flying straight from tile `from` to tile `to` (the
 * strike preview's estimate; sampled every tile), capped at 1.
 */
export function flakPathWear(state: GameState, owner: number, from: number, to: number, factor = 1): number {
  const g = gridOf(state);
  if (!g || factor <= 0) return 0;
  const w = state.map.width;
  const x0 = from % w;
  const y0 = (from / w) | 0;
  const dx = (to % w) - x0;
  const dy = ((to / w) | 0) - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const n = Math.max(1, Math.ceil(len));
  let wear = 0;
  for (let k = 0; k < n; k++) {
    const f = (k + 0.5) / n;
    wear += (len / n) * flakRateAt(state, owner, x0 + dx * f, y0 + dy * f, g);
  }
  return Math.min(1, wear * factor);
}

/**
 * Flak check (units.updateUnits, after the planes moved and before interception): every flakCheckTicks ticks each
 * outbound plane in `planes` adds the wear of the stretch it flew; at flakAbortAt it turns home (removed from
 * `arrived`: it releases nothing).
 */
export function updateFlak(state: GameState, planes: readonly Unit[], arrived: Set<Unit>): void {
  const since = state.tick % DEFENSE.flakCheckTicks;
  const check = since === 0;
  // between checks only planes over their aim this tick: the stretch since the last check still counts (no abort)
  if (!check && !arrived.size) return;
  const g = gridOf(state);
  if (!g) return;
  const w = state.map.width;
  for (const u of planes) {
    if (u.hp <= 0 || u.state !== 0) continue;
    const over = arrived.has(u);
    if (!check && !over) continue;
    const factor = flakFactor(u);
    if (factor <= 0) continue;
    const ticks = check ? DEFENSE.flakCheckTicks : since;
    const speed = UNITS[u.type].speed * techAirSpeedMul(state, u.owner);
    // the stretch flown since the last check: back along the straight line toward home
    const hx = (u.home % w) - u.x;
    const hy = ((u.home / w) | 0) - u.y;
    const dh = Math.sqrt(hx * hx + hy * hy);
    const len = Math.min(dh, speed * TICK_SECONDS * ticks);
    if (len <= 0) continue;
    const n = Math.max(1, Math.ceil(len));
    let add = 0;
    let by = 0;
    for (let k = 0; k < n; k++) {
      const f = ((k + 0.5) / n) * (len / Math.max(dh, 1e-9));
      const zones = flakZonesAt(state, u.owner, u.x + hx * f, u.y + hy * f, g);
      let r = 0;
      for (const s of zones) r += s.rate;
      if (r > 0 && !by) by = zones[0].owner;
      add += (len / n) * r;
    }
    if (add <= 0) continue;
    u.flakWear = Math.min(1, (u.flakWear ?? 0) + add * factor);
    if (u.flakWear >= DEFENSE.flakAbortAt && !over) abortPlane(state, u, by);
  }
}

/** A plane worn too much turns home: bombers keep their bombs, cargo planes bring the paratroopers back. */
function abortPlane(state: GameState, u: Unit, by: number): void {
  u.state = 1;
  u.target = u.home;
  const me = state.players[u.owner];
  const them = state.players[by];
  if (!me || !them) return;
  const what = u.type === 'transportPlane' ? 'cargo plane' : u.type === 'stealthBomber' ? 'stealth bomber' : 'bomber';
  const w = state.map.width;
  const here = Math.round(u.y) * w + Math.round(u.x);
  addEvent(state, 'bombing', `${them.name}'s flak turned back a ${what} of ${me.name}`, [u.owner, by], here);
}

/**
 * Strike multiplier of plane u after flak: x (1 - wear), then x the air superiority multiplier `sup`, never below
 * flakEffectFloor (nor above sup). A plane with no wear gets sup unchanged.
 */
export function flakCut(u: Unit, sup: number): number {
  const wear = u.flakWear ?? 0;
  if (wear <= 0) return sup;
  return Math.max(Math.min(sup, DEFENSE.flakEffectFloor), (1 - wear) * sup);
}
/** The end of a bombing message when flak wore the plane (" (flak: 30% less)"), else ''. */
export function flakNote(u: Unit): string {
  const wear = u.flakWear ?? 0;
  return wear > 0.005 ? ` (flak: ${Math.round(Math.min(1 - DEFENSE.flakEffectFloor, wear) * 100)}% less)` : '';
}

// ---------------------------------------------------------------------------------------------------------------
// Tank Traps
// ---------------------------------------------------------------------------------------------------------------

/** True if `tile` of `owner` holds tank traps: own trench level >= trapMinTrench inside a working own Fort's radius. */
export function isTrapTile(state: GameState, tile: number, owner: number): boolean {
  return trapStrength(state, tile, owner) > 0;
}
/** How far (tiles) Fort b of a Tank Traps holder lays traps: its radius + DEFENSE.trapBelt. */
export function trapReach(state: GameState, b: Building): number {
  return fortRadius(state, b) + DEFENSE.trapBelt;
}
/**
 * Trap strength of `tile` for its owner `owner` (0 = no traps): own land of a Tank Traps holder within trapReach of a
 * finished, working own Fort; 1 on dug land (trench level >= trapMinTrench), trapPlain elsewhere. Pure read.
 */
export function trapStrength(state: GameState, tile: number, owner: number): number {
  if (owner <= 0 || state.map.owner[tile] !== owner) return 0;
  const p = state.players[owner];
  if (!p || !hasTech(p, 'tankTraps')) return 0;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  let inside = false;
  for (const b of buildingsOf(state, owner, 'fort')) {
    if (b.buildLeft > 0 || b.disabledUntil > state.tick || state.buildings.get(b.id) !== b) continue;
    const r = trapReach(state, b);
    const dx = (b.tile % w) - x;
    const dy = ((b.tile / w) | 0) - y;
    if (dx * dx + dy * dy <= r * r) {
      inside = true;
      break;
    }
  }
  if (!inside) return 0;
  return trenchLevel(state, tile) >= DEFENSE.trapMinTrench ? 1 : DEFENSE.trapPlain;
}
/**
 * Trap penalty factor for division u (1 = full): light tanks x1.3, heavy x0.7, Siege Tanks x0; x trapArtillery with
 * artillery support.
 */
export function trapFactor(state: GameState, u: Unit, artillery: boolean): number {
  const p = state.players[u.owner];
  let f = 1;
  if (u.variant === 'lightTank') f = DEFENSE.trapLight;
  else if (u.variant === 'heavyTank') f = p && hasTech(p, 'siegeTanks') ? DEFENSE.trapSiege : DEFENSE.trapHeavy;
  if (artillery) f *= DEFENSE.trapArtillery;
  return f;
}
/** Head speed x on a trap tile for penalty factor f (f = 1: trapHeadSpeed). */
export function trapSpeedMul(f: number): number {
  return Math.max(0, Math.min(1, 1 - (1 - DEFENSE.trapHeadSpeed) * f));
}
/** A Breakthrough's surge on a trap tile: BLITZ.speedMul's extra x trapBlitzSurge. */
export function trapBlitzSpeedMul(): number {
  return 1 + (BLITZ.speedMul - 1) * DEFENSE.trapBlitzSurge;
}
/** Troops division u loses taking one trap tile (factor f), within its trapMaxLoss budget for this spearhead. */
export function trapTileLoss(u: Unit, f: number, strength0: number): number {
  if (f <= 0) return 0;
  const left = DEFENSE.trapMaxLoss * strength0 - (u.trapLoss ?? 0);
  return Math.max(0, Math.min(left, DEFENSE.trapLossPerTile * f * strength0));
}

// ---------------------------------------------------------------------------------------------------------------
// Tracking Radar
// ---------------------------------------------------------------------------------------------------------------

/** True if player pid holds Tracking Radar. */
export function hasTrackingRadar(state: GameState, pid: number): boolean {
  const p = state.players[pid];
  return !!p && pid > 0 && hasTech(p, 'trackingRadar');
}
/** Tracking radar radius (tiles) of SAM site b: radarReach x its SAM reach (x Early Warning). */
export function radarRadius(state: GameState, b: Building): number {
  return samRadius(b) * earlyWarningMul(state, b.owner) * DEFENSE.radarReach;
}
/** Ticks a stealth bomber must spend inside one radar circle before it is spotted. */
export const RADAR_LOCK_TICKS = Math.round(DEFENSE.radarLockSeconds * TICKS_PER_SECOND);

/** Ticks stealth bomber u has spent inside the radar of SAM site `samId` this flight (0 = none). */
export function radarLockTicks(u: Unit, samId: number): number {
  const l = u.radarLock;
  if (!l) return 0;
  for (let k = 0; k < l.length; k += 2) if (l[k] === samId) return l[k + 1];
  return 0;
}

/**
 * Tracking Radar, every tick before interception (units.ts): every hostile holder's finished, working SAM sites add a
 * tick to their lock on each stealth bomber inside their radar circle; Unit.radarSeen becomes the holders whose
 * locked circle holds it now. A side that newly spots it is told (and the bomber's owner), with a 'radarLock' effect.
 */
export function updateRadar(state: GameState, planes: readonly Unit[]): void {
  let holders: number[] | null = null;
  for (const u of planes) {
    if (u.type !== 'stealthBomber' || u.hp <= 0) continue;
    holders ??= state.players.filter((p) => p.id > 0 && p.alive && hasTech(p, 'trackingRadar')).map((p) => p.id);
    const before = u.radarSeen;
    if (!holders.length) {
      if (before) delete u.radarSeen;
      continue;
    }
    const w = state.map.width;
    const lock = u.radarLock ? u.radarLock.slice() : [];
    const seen: number[] = [];
    for (const pid of holders) {
      if (!hostile(state, pid, u.owner)) continue;
      let spotted = false;
      for (const b of buildingsOf(state, pid, 'sam')) {
        if (!flakWorking(state, b)) continue;
        const r = radarRadius(state, b);
        const dx = (b.tile % w) + 0.5 - (u.x + 0.5);
        const dy = ((b.tile / w) | 0) + 0.5 - (u.y + 0.5);
        if (dx * dx + dy * dy > r * r) continue;
        let k = 0;
        while (k < lock.length && lock[k] < b.id) k += 2;
        if (k < lock.length && lock[k] === b.id) lock[k + 1]++;
        else lock.splice(k, 0, b.id, 1);
        if (lock[k + 1] >= RADAR_LOCK_TICKS) spotted = true;
      }
      if (spotted) seen.push(pid);
    }
    if (lock.length) u.radarLock = lock;
    if (seen.length) u.radarSeen = seen;
    else if (before) delete u.radarSeen;
    for (const pid of seen) {
      if (before?.includes(pid)) continue;
      const tile = (Math.round(u.y) * w + Math.round(u.x)) | 0;
      state.effects.push({ kind: 'radarLock', x: u.x + 0.5, y: u.y + 0.5, radius: 1, tick: state.tick });
      const by = state.players[pid].name;
      addEvent(state, 'bombing', `${by}'s Tracking Radar spotted a stealth bomber of ${state.players[u.owner].name}: SAMs and fighters can shoot at it`, [pid, u.owner], tile);
    }
  }
}

/** A stealth bomber shot down: its owner's next one may fly STEALTH.lostCooldownSeconds from now (units.ts shotDown). */
export function stealthLost(state: GameState, u: Unit): void {
  const p = state.players[u.owner];
  if (!p) return;
  const at = state.tick + Math.round(STEALTH.lostCooldownSeconds * TICKS_PER_SECOND);
  p.stealthReady = Math.max(p.stealthReady ?? 0, at);
}

/** Tracking radar circles of SAM sites of `owner` (finished, working): for the client's aim rings. */
export function radarCircles(state: GameState, owner: number): { tile: number; r: number; building: Building }[] {
  if (!hasTrackingRadar(state, owner)) return [];
  const out: { tile: number; r: number; building: Building }[] = [];
  for (const b of buildingsOf(state, owner, 'sam')) if (flakWorking(state, b)) out.push({ tile: b.tile, r: radarRadius(state, b), building: b });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Coastal Batteries
// ---------------------------------------------------------------------------------------------------------------

/** True if player pid holds Coastal Batteries. */
export function hasBatteries(state: GameState, pid: number): boolean {
  const p = state.players[pid];
  return !!p && pid > 0 && hasTech(p, 'coastalBatteries');
}
/** Battery range (tiles) of site b: batteryRange + per level above 1, at most batteryRangeMax (below battleship shelling). */
export function batteryRange(b: Building): number {
  return Math.min(DEFENSE.batteryRangeMax, DEFENSE.batteryRange + DEFENSE.batteryRangePerLevel * (b.level - 1));
}
/** True if Fort b stands within DEFENSE.batteryCoast tiles of water (a coastal fort). Pure read. */
export function coastalFort(state: GameState, b: Building): boolean {
  const map = state.map;
  const w = map.width;
  const x = b.tile % w;
  const y = (b.tile / w) | 0;
  const r = DEFENSE.batteryCoast;
  for (let j = -r; j <= r; j++) {
    const ty = y + j;
    if (ty < 0 || ty >= map.height) continue;
    for (let i = -r; i <= r; i++) {
      const tx = x + i;
      if (tx < 0 || tx >= w || i * i + j * j > r * r) continue;
      if (isWater(map.terrain[ty * w + tx])) return true;
    }
  }
  return false;
}
/** True if building b is a battery site type for its owner: a Port, or a coastal Fort, of a Coastal Batteries holder (built or not). */
export function isBatterySite(state: GameState, b: Building): boolean {
  if (b.type !== 'port' && b.type !== 'fort') return false;
  if (!hasBatteries(state, b.owner)) return false;
  return b.type === 'port' || coastalFort(state, b);
}
/** True while battery b fires: finished, not knocked out, hp at least batteryFireHp. */
export function batteryWorking(state: GameState, b: Building): boolean {
  return b.buildLeft <= 0 && b.disabledUntil <= state.tick && b.hp >= DEFENSE.batteryFireHp;
}

interface BatteryCache {
  key: string;
  sites: Building[];
}
const batteryCaches = new WeakMap<GameState, BatteryCache>();

/** Finished battery sites (Ports and coastal Forts of holders), working or not; cached on buildingsVersion and the holders. */
export function batterySites(state: GameState): readonly Building[] {
  const hs: number[] = [];
  for (const p of state.players) if (p.id > 0 && p.alive && hasTech(p, 'coastalBatteries')) hs.push(p.id);
  if (!hs.length) return [];
  const key = `${state.buildingsVersion}|${hs.join(',')}`;
  const old = batteryCaches.get(state);
  if (old && old.key === key) return old.sites;
  const sites: Building[] = [];
  for (const pid of hs) {
    for (const b of buildingsOf(state, pid, 'port')) if (b.buildLeft <= 0) sites.push(b);
    for (const b of buildingsOf(state, pid, 'fort')) if (b.buildLeft <= 0 && coastalFort(state, b)) sites.push(b);
  }
  sites.sort((a, b) => a.id - b.id);
  batteryCaches.set(state, { key, sites });
  return sites;
}

/** Working batteries hostile to `owner` (at war with it, or of nation `q` when given) whose range covers tile t. */
export function batteriesCovering(state: GameState, owner: number, t: number, q = 0): number {
  const sites = batterySites(state);
  if (!sites.length) return 0;
  const w = state.map.width;
  const x = t % w;
  const y = (t / w) | 0;
  let n = 0;
  for (const b of sites) {
    if (b.owner === owner || (b.owner !== q && !atWar(state, owner, b.owner)) || !hostile(state, owner, b.owner) || !batteryWorking(state, b)) continue;
    const dx = (b.tile % w) - x;
    const dy = ((b.tile / w) | 0) - y;
    const r = batteryRange(b);
    if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}

/** Target rank of ship s for battery b (lower first; 99 = not a target). */
function batteryRank(state: GameState, s: Unit, d2: number): number {
  if (s.type !== 'warship') return 99; // transports: shore fire (updateShoreFire)
  const reload = Math.round(CRUISE.reloadSeconds * TICKS_PER_SECOND);
  if (s.cruiseReady !== undefined && state.tick < s.cruiseReady - reload + DEFENSE.batteryCruiseMemory * TICKS_PER_SECOND) return 0;
  const reach = WARSHIP_SHELL_RANGE * navalShellRangeMul(state, s);
  if (navalShellMul(s) > 0 && d2 <= reach * reach) return 1;
  return 3;
}

/**
 * Coastal Batteries, every tick after the ships moved (units.ts): each working battery whose turn it is
 * ((tick + id) % batteryFireSeconds) fires at its best target (batteryRank, then nearest, then id).
 */
export function updateBatteries(state: GameState, ships: readonly Unit[]): void {
  const sites = batterySites(state);
  if (!sites.length || !ships.length) return;
  const every = Math.max(1, Math.round(DEFENSE.batteryFireSeconds * TICKS_PER_SECOND));
  const w = state.map.width;
  for (const b of sites) {
    if ((state.tick + b.id) % every !== 0 || !batteryWorking(state, b) || !state.buildings.has(b.id)) continue;
    const bx = b.tile % w;
    const by = (b.tile / w) | 0;
    const r = batteryRange(b);
    let best: Unit | null = null;
    let bestRank = 99;
    let bestD = Infinity;
    for (const s of ships) {
      if (s.hp <= 0 || s.type !== 'warship' || s.owner === b.owner) continue;
      const dx = s.x - bx;
      const dy = s.y - by;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      if (!atWar(state, b.owner, s.owner)) continue;
      const rank = batteryRank(state, s, d2);
      if (rank > bestRank || (rank === bestRank && (d2 > bestD || (d2 === bestD && best !== null && s.id > best.id)))) continue;
      if (!unitVisibleTo(state, b.owner, s)) continue; // hidden submarines
      best = s;
      bestRank = rank;
      bestD = d2;
    }
    if (best) batteryHit(state, b, best);
  }
  updateShoreFire(state, sites, ships);
}

/** True if battery b fires at transport s: hostile, and at war with it or the nation it sails to invade. */
function shoreFoe(state: GameState, b: Building, s: Unit): boolean {
  if (s.owner === b.owner || !hostile(state, s.owner, b.owner)) return false;
  return s.targetOwner === b.owner || atWar(state, b.owner, s.owner);
}

/**
 * Shore fire on transports, every tick: a sailing transport inside the range of working hostile batteries loses
 * batteryTransportPerTile x tiles sailed this tick x (1 + batteryTransportExtra x (covering - 1), at most
 * batteryTransportStack counted) of its troops, within batteryTransportMaxLoss per voyage (Unit.shoreLoss).
 */
function updateShoreFire(state: GameState, sites: readonly Building[], ships: readonly Unit[]): void {
  const w = state.map.width;
  const every = TICKS_PER_SECOND;
  for (const s of ships) {
    if (s.type !== 'transport' || s.hp <= 0 || s.pathPos >= s.path.length) continue;
    const used = s.shoreLoss ?? 0;
    if (used >= DEFENSE.batteryTransportMaxLoss) continue;
    const aboard = s.troops.infantry + s.troops.armor + s.troops.artillery;
    if (aboard <= 0) continue;
    let n = 0;
    let near: Building | null = null;
    let nearD = Infinity;
    for (const b of sites) {
      if (!shoreFoe(state, b, s) || !batteryWorking(state, b) || !state.buildings.has(b.id)) continue;
      const dx = s.x - (b.tile % w);
      const dy = s.y - ((b.tile / w) | 0);
      const d2 = dx * dx + dy * dy;
      const r = batteryRange(b);
      if (d2 > r * r) continue;
      n++;
      if (d2 < nearD) {
        near = b;
        nearD = d2;
      }
    }
    if (!near) continue;
    const tiles = (s.cargo > 0 ? s.cargo : UNITS.transport.speed) * TICK_SECONDS;
    const stack = 1 + DEFENSE.batteryTransportExtra * (Math.min(n, DEFENSE.batteryTransportStack) - 1);
    const f = Math.min(DEFENSE.batteryTransportMaxLoss - used, DEFENSE.batteryTransportPerTile * tiles * stack);
    if (f <= 0) continue;
    let lost = 0;
    for (const t of TROOP_TYPES) {
      const k = s.troops[t] * f;
      s.troops[t] -= k;
      lost += k;
    }
    s.shoreLoss = used + f;
    state.players[s.owner].stats.troopsLost += lost;
    state.players[near.owner].stats.troopsKilled += lost;
    // a shell on the way about once a second per transport (the client's muzzle flash, arc and splash)
    if ((state.tick + s.id) % every === 0) {
      state.effects.push({ kind: 'battery', x: (near.tile % w) + 0.5, y: ((near.tile / w) | 0) + 0.5, x2: s.x + 0.5, y2: s.y + 0.5, radius: 0.5, tick: state.tick });
    }
  }
}

function batteryHit(state: GameState, b: Building, s: Unit): void {
  const w = state.map.width;
  state.effects.push({ kind: 'battery', x: (b.tile % w) + 0.5, y: ((b.tile / w) | 0) + 0.5, x2: s.x + 0.5, y2: s.y + 0.5, radius: 1, tick: state.tick });
  const by = state.players[b.owner];
  const victim = state.players[s.owner];
  s.hp -= DEFENSE.batteryDamage;
  if (s.hp > 1e-9) return;
  s.hp = 0;
  state.effects.push({ kind: 'explosion', x: s.x + 0.5, y: s.y + 0.5, radius: 1.5, tick: state.tick });
  const what = UNITS.warship.name.toLowerCase();
  addEvent(state, 'unitLost', `${victim.name} lost a ${what} to ${by.name}'s coastal battery`, [s.owner, b.owner], (Math.round(s.y) * w + Math.round(s.x)) | 0);
}

/**
 * The battery warship u shells first ('' none): AI ships, and a player's auto and bombard ships, pick the nearest
 * working hostile battery of a nation they are at war with inside their shelling reach.
 */
export function shellBatteryTarget(state: GameState, u: Unit, reach: number, wars: Set<number>): Building | null {
  const sites = batterySites(state);
  if (!sites.length) return null;
  const p = state.players[u.owner];
  if (!p) return null;
  const st = u.stance ?? 'auto';
  if (p.isHuman && st !== 'auto' && st !== 'bombard') return null;
  const w = state.map.width;
  let best: Building | null = null;
  let bestD = reach * reach;
  for (const b of sites) {
    if (!wars.has(u.owner * 1024 + b.owner) || !hostile(state, u.owner, b.owner) || !batteryWorking(state, b)) continue;
    const dx = (b.tile % w) - u.x;
    const dy = ((b.tile / w) | 0) - u.y;
    const d = dx * dx + dy * dy;
    if (d > bestD || (d === bestD && best && b.id > best.id)) continue;
    best = b;
    bestD = d;
  }
  return best;
}

/** Warship u shells battery b for `amount` (shelling x seconds): hp off, never below batteryHpFloor; told once silenced. */
export function shellBattery(state: GameState, u: Unit, b: Building, amount: number): void {
  const was = b.hp;
  b.hp = Math.max(DEFENSE.batteryHpFloor, b.hp - DEFENSE.batteryShellDamage * amount);
  if (was >= DEFENSE.batteryFireHp && b.hp < DEFENSE.batteryFireHp) {
    addEvent(state, 'info', `${state.players[u.owner].name}'s ships shelled a coastal battery of ${state.players[b.owner].name} silent`, [b.owner, u.owner], b.tile);
  }
}
