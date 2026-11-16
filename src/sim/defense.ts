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
//   - A trap tile is an own tile with trench level >= trapMinTrench inside the radius of a finished, working own Fort
//     of a Tank Traps holder. Derived, never stored (trenches and forts are hashed already); barrages and atom bombs
//     flatten the trench and the traps with it, a captured tile starts undug.
//   - A hostile spearhead head on a trap tile moves at trapHeadSpeed of its speed, and the division loses
//     trapLossPerTile of its start strength per trap tile taken, at most trapMaxLoss per spearhead (Unit.trapLoss,
//     hashed). Light tanks x1.3, heavy x0.7, Siege Tanks x0; artillery support halves it; a Breakthrough's surge is
//     x trapBlitzSurge there (tanks.ts).
// Part 2 (Tracking Radar, Coastal Batteries) and part 3 (Counteroffensive) hook in here.
// Deterministic: state only, no RNG; caches are WeakMaps keyed by the GameState and rebuilt from it.
import { BLITZ, DEFENSE, TICK_SECONDS, UNITS } from './config';
import { buildingsOf, isFortified } from './buildings';
import { areAllied } from './diplomacy';
import { atPeace } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { techAirSpeedMul } from './techtree';
import { trenchLevel } from './trenches';
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

interface FlakGrid {
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

/** The cached flak site grid (rebuilt when buildings or the holders change); null when nobody holds Flak Guns. */
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
export function flakZonesAt(state: GameState, planeOwner: number, x: number, y: number): readonly FlakSite[] {
  topScratch.length = 0;
  const g = gridOf(state);
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
export function flakRateAt(state: GameState, planeOwner: number, x: number, y: number): number {
  let r = 0;
  for (const s of flakZonesAt(state, planeOwner, x, y)) r += s.rate;
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
  if (!gridOf(state) || factor <= 0) return 0;
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
    wear += (len / n) * flakRateAt(state, owner, x0 + dx * f, y0 + dy * f);
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
  if (!gridOf(state)) return;
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
      const zones = flakZonesAt(state, u.owner, u.x + hx * f, u.y + hy * f);
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
  if (owner <= 0 || state.map.owner[tile] !== owner) return false;
  const p = state.players[owner];
  if (!p || !hasTech(p, 'tankTraps')) return false;
  if (trenchLevel(state, tile) < DEFENSE.trapMinTrench) return false;
  return isFortified(state, tile, owner);
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
