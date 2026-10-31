// Vehicle variants (Arsenal paths, arsenal.ts) and the shared unlocks: what each one does. The sim systems call the
// small hooks below (naval2.ts / navy.ts / units.ts for warships, tanks.ts / armor2.ts for divisions, airwings.ts for
// bombers, buildings.hasIntel and techtree.unitVisibleTo for reveals); numbers in config ARSENAL.
//
// Navy (per ship: Unit.variant, chosen when ordering: Action buildWarship.variant; default = the path's first ship)
//   destroyer   fast, cheap; sonar reveals submarines nearby and hits them very hard; weak shelling
//   battleship  slow, expensive, tough; shells coast from twice as far and much harder; long naval support
//   submarine   hidden (techtree.unitVisibleTo) and only fired at up close (or by destroyers); hits trade ships and
//               transports much harder; longer blockades, richer captures; never shells, gives no support
//   carrier     a moving airfield: air wings strike targets within carrierAirRange of it (the bombers launch from it,
//               airwings.ts); its fighters shoot down planes nearby (techtree.interceptByCarriers); long support
// Armor (per player: the path; every division of the owner is that variant, Unit.variant mirrors it for the UI)
//   lightTank   cheaper, much faster and deeper, a thin band; reveals the enemy ahead (RevealZone kind 2); forests,
//               hills, mountains and forts cost it more; holds ground worse
//   heavyTank   slower and dearer; drives through forts and mountains without artillery and loses less there; holds
//               ground better. Siege Tanks: knocks out the forts it passes.
// Air (per player: the path; bombers are stamped at launch)
//   groundAttack  support strikes stronger, raids weaker;  heavyBomber  raids stronger, longer range, +1 hp
// Shared: Mechanized infantry (spearheads lose less; the land they took holds: HoldZone), Recon planes (Action
// reconFlight: a plane flies to a tile and reveals a circle: intel on the nations there, their hidden submarines).
// Masteries: Naval (xp x2, reach x1.3, +2 ships), Armor (bigger pockets collapse), Air (wing size x1.5).
// Deterministic: no RNG, no transcendental Math; zones are plain arrays in state.arsenal (hashed: hashArsenal).
import { ARSENAL, TICKS_PER_SECOND, TICK_SECONDS, UNITS } from './config';
import type { NavalVariantInfo } from './config';
import { buildingAt, buildingsOf } from './buildings';
import { areAllied } from './diplomacy';
import { atPeace, peaceReason, unitRule } from './rules';
import { addEvent, newId } from './state';
import { Terrain } from './types';
import type { ActionResult, ArsenalState, Building, GameState, NavalVariant, Player, TechId, Unit, UnitVariant } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });
const has = (p: Player | undefined, t: TechId): boolean => !!p && p.techs.includes(t);
function pl(state: GameState, id: number): Player | undefined {
  return id > 0 ? state.players[id] : undefined;
}
function d2(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
}
function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** Display names of the variants. */
export const VARIANT_NAMES: Record<UnitVariant, string> = {
  destroyer: 'Destroyer',
  battleship: 'Battleship',
  submarine: 'Submarine',
  carrier: 'Carrier',
  lightTank: 'Light tanks',
  heavyTank: 'Heavy tanks',
  groundAttack: 'Ground-attack planes',
  heavyBomber: 'Heavy bombers',
};
/** The tech that unlocks each warship variant. */
export const NAVAL_VARIANT_TECH: Record<NavalVariant, TechId> = { destroyer: 'destroyers', battleship: 'battleships', submarine: 'submarines', carrier: 'carriers' };
const NAVAL_TECH_NAME: Record<NavalVariant, string> = { destroyer: 'Destroyers', battleship: 'Battleships', submarine: 'Submarines', carrier: 'Carriers' };

/** The arsenal state (created on first use). */
export function arsenalState(state: GameState): ArsenalState {
  if (!state.arsenal) state.arsenal = { reveals: [], holds: [], reconReady: [] };
  return state.arsenal;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths of a player
// ---------------------------------------------------------------------------------------------------------------

/** Warship variants playerId may order now (in fork order). */
export function navalVariantsOf(state: GameState, pid: number): NavalVariant[] {
  const p = pl(state, pid);
  const out: NavalVariant[] = [];
  for (const v of ['destroyer', 'battleship', 'submarine', 'carrier'] as const) if (has(p, NAVAL_VARIANT_TECH[v])) out.push(v);
  return out;
}
/** The variant a warship order without one gets: the path's first ship (destroyer / submarine); undefined = standard. */
export function defaultNavalVariant(state: GameState, pid: number): NavalVariant | undefined {
  const p = pl(state, pid);
  if (has(p, 'destroyers')) return 'destroyer';
  if (has(p, 'submarines')) return 'submarine';
  return undefined;
}
/** Why playerId can't order variant v (undefined = the default, always fine), or null. */
export function navalVariantBlock(state: GameState, pid: number, v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v !== 'string' || !Object.prototype.hasOwnProperty.call(ARSENAL.naval, v)) return 'Unknown ship type';
  const nv = v as NavalVariant;
  return has(pl(state, pid), NAVAL_VARIANT_TECH[nv]) ? null : `Needs research: ${NAVAL_TECH_NAME[nv]}`;
}

/** The tank variant of playerId's divisions (its Armor path), or undefined. */
export function armorVariantOf(state: GameState, pid: number): 'lightTank' | 'heavyTank' | undefined {
  const p = pl(state, pid);
  if (has(p, 'lightTanks')) return 'lightTank';
  if (has(p, 'heavyTanks')) return 'heavyTank';
  return undefined;
}
/** The bomber variant of playerId (its Air path), or undefined. */
export function airVariantOf(state: GameState, pid: number): 'groundAttack' | 'heavyBomber' | undefined {
  const p = pl(state, pid);
  if (has(p, 'groundAttack')) return 'groundAttack';
  if (has(p, 'heavyBombers')) return 'heavyBomber';
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Warships
// ---------------------------------------------------------------------------------------------------------------

/** The numbers of a warship's variant, or null for a standard warship (or another unit). */
export function navalInfo(u: Unit | undefined): NavalVariantInfo | null {
  if (!u || u.type !== 'warship' || !u.variant) return null;
  return (ARSENAL.naval as Record<string, NavalVariantInfo>)[u.variant] ?? null;
}
/** Price x of a warship variant (1 = standard). */
export function navalCostMul(v: NavalVariant | undefined): number {
  return v ? ARSENAL.naval[v].cost : 1;
}
/** A warship price with variant v (rounded like units.unitCost). */
export function variantWarshipCost(base: { gold: number; iron: number; oil: number }, v: NavalVariant | undefined): { gold: number; iron: number; oil: number } {
  const k = navalCostMul(v);
  return { gold: Math.round(base.gold * k), iron: Math.round(base.iron * k), oil: Math.round(base.oil * k) };
}
/** A new warship gets its variant: the field and its extra hit points. */
export function applyWarshipVariant(u: Unit, v: NavalVariant | undefined): void {
  if (!v) return;
  u.variant = v;
  u.hp += ARSENAL.naval[v].hp;
}
/** Speed x of a warship's variant. */
export function navalSpeedMul(u: Unit): number {
  return navalInfo(u)?.speed ?? 1;
}
/** Extra max hp of a warship's variant. */
export function navalExtraHp(u: Unit): number {
  return navalInfo(u)?.hp ?? 0;
}
/** Auto-intercept detection range x. */
export function navalDetectMul(u: Unit): number {
  return navalInfo(u)?.detect ?? 1;
}
/** Damage x of warship u against ship `target` (variant of the shooter and of a submarine target). */
export function navalDamageMul(u: Unit, target: Unit): number {
  const a = navalInfo(u);
  let m = 1;
  if (target.variant === 'submarine') m *= a ? a.vsSub : 1;
  else if (target.type === 'warship') m *= a ? a.damage : 1;
  else m *= a ? a.vsTrade : 1; // trade ships, transports
  if (target.variant === 'submarine' && u.variant !== 'destroyer') m *= ARSENAL.subHitByOthers;
  return m;
}
/** Shore shelling kill x of warship u (0 = this variant never shells). */
export function navalShellMul(u: Unit): number {
  return navalInfo(u)?.shell ?? 1;
}
/** Shelling reach x of warship u (variant, Naval Mastery). */
export function navalShellRangeMul(state: GameState, u: Unit): number {
  return (navalInfo(u)?.shellRange ?? 1) * navalReachMul(state, u.owner);
}
/** Naval support range x of one ship (variant; 0 = none). */
export function navalSupportMul(u: Unit): number {
  return navalInfo(u)?.support ?? 1;
}
/** Naval support / bombardment reach x of a player (Naval Mastery). */
export function navalReachMul(state: GameState, pid: number): number {
  return has(pl(state, pid), 'navalMastery') ? ARSENAL.navalMasteryRange : 1;
}
/** Blockade range x of one ship. */
export function navalBlockadeMul(u: Unit): number {
  return navalInfo(u)?.blockade ?? 1;
}
/** Captured trade gold x for ship u (submarines). */
export function navalCaptureMul(u: Unit): number {
  return u.variant === 'submarine' ? ARSENAL.subCapture : 1;
}
/** Veterancy xp x (Naval Mastery). */
export function navalXpMul(state: GameState, pid: number): number {
  return has(pl(state, pid), 'navalMastery') ? ARSENAL.navalMasteryXp : 1;
}
/** Extra warships allowed (Naval Mastery). */
export function navalExtraShips(state: GameState, pid: number): number {
  return has(pl(state, pid), 'navalMastery') ? ARSENAL.navalMasteryShips : 0;
}

/** True when `viewer` has a reveal (recon flight, light-tank screen) covering (x, y) now. */
export function revealedAt(state: GameState, viewer: number, x: number, y: number): boolean {
  const a = state.arsenal;
  if (!a || viewer <= 0) return false;
  const w = state.map.width;
  for (const z of a.reveals) {
    if (z.owner !== viewer || z.untilTick <= state.tick) continue;
    if (d2(z.tile % w, (z.tile / w) | 0, x, y) <= z.radius * z.radius) return true;
  }
  return false;
}
/** A destroyer of `viewer` (alive) within its sonar range of (x, y)? */
function sonarAt(state: GameState, viewer: number, x: number, y: number): boolean {
  const r2 = ARSENAL.destroyerSonar * ARSENAL.destroyerSonar;
  for (const s of state.units) {
    if (s.owner !== viewer || s.variant !== 'destroyer' || s.hp <= 0 || s.type !== 'warship') continue;
    if (d2(s.x, s.y, x, y) <= r2) return true;
  }
  return false;
}
/** Submarine `sub` is revealed to `viewer` by its destroyers' sonar or a recon flight (techtree.unitVisibleTo). */
export function subRevealedTo(state: GameState, viewer: number, sub: Unit): boolean {
  return sonarAt(state, viewer, sub.x, sub.y) || revealedAt(state, viewer, sub.x, sub.y);
}
/**
 * May warship `shooter` fire at / chase ship `target`? Everything but a submarine: yes. A submarine only when it is
 * within ARSENAL.subTargetRange, or the shooter is a destroyer (sonar), or the shooter's owner sees it from elsewhere
 * (another destroyer, recon).
 */
export function navalCanTarget(state: GameState, shooter: Unit, target: Unit): boolean {
  if (target.variant !== 'submarine') return true;
  const d = d2(shooter.x, shooter.y, target.x, target.y);
  if (d <= ARSENAL.subTargetRange * ARSENAL.subTargetRange) return true;
  if (shooter.variant === 'destroyer' && d <= ARSENAL.destroyerSonar * ARSENAL.destroyerSonar) return true;
  return subRevealedTo(state, shooter.owner, target);
}

/**
 * Carriers (airwings.ts): the own carrier nearest `aim` that has it within carrierAirRange, or null. Bombers of a
 * wing whose airfield is out of reach launch from it.
 */
export function carrierFor(state: GameState, owner: number, aim: number): Unit | null {
  const w = state.map.width;
  const ax = aim % w;
  const ay = (aim / w) | 0;
  const r2 = ARSENAL.carrierAirRange * ARSENAL.carrierAirRange;
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const u of state.units) {
    if (u.owner !== owner || u.variant !== 'carrier' || u.type !== 'warship' || u.hp <= 0) continue;
    const d = d2(u.x, u.y, ax, ay);
    if (d <= r2 && (d < bestD || (d === bestD && best !== null && u.id < best.id))) {
      best = u;
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Tank divisions (per-player path)
// ---------------------------------------------------------------------------------------------------------------

/** Division price x (light cheaper, heavy dearer). */
export function armorCostMul(state: GameState, pid: number): number {
  const v = armorVariantOf(state, pid);
  return v === 'lightTank' ? ARSENAL.light.cost : v === 'heavyTank' ? ARSENAL.heavy.cost : 1;
}
/** Spearhead head speed x. */
export function armorSpeedMul(state: GameState, pid: number): number {
  const v = armorVariantOf(state, pid);
  if (v === 'lightTank') return ARSENAL.light.speed * (has(pl(state, pid), 'deepRaids') ? ARSENAL.deepRaidsSpeed : 1);
  return v === 'heavyTank' ? ARSENAL.heavy.speed : 1;
}
/** Spearhead depth x. */
export function armorDepthMul(state: GameState, pid: number): number {
  const v = armorVariantOf(state, pid);
  if (v === 'lightTank') return ARSENAL.light.depth * (has(pl(state, pid), 'deepRaids') ? ARSENAL.deepRaidsDepth : 1);
  return v === 'heavyTank' ? ARSENAL.heavy.depth : 1;
}
/** Spearhead band width in tiles (odd): light tanks run a thin line. */
export function armorBandWidth(state: GameState, pid: number, base: number): number {
  return armorVariantOf(state, pid) === 'lightTank' ? Math.min(base, ARSENAL.light.width) : base;
}
/** Heavy tanks drive through mountains and forts without artillery. */
export function armorBreaksThrough(state: GameState, pid: number): boolean {
  return armorVariantOf(state, pid) === 'heavyTank';
}
/** Spearhead loss x on a tile: variant (rough ground / forts), Siege Tanks, Mechanized infantry. */
export function armorLossMul(state: GameState, pid: number, terrain: number, fortified: boolean): number {
  const v = armorVariantOf(state, pid);
  const rough = fortified || terrain === Terrain.Mountains || terrain === Terrain.Hills || terrain === Terrain.Forest;
  let m = 1;
  if (v === 'lightTank' && rough) m *= ARSENAL.light.roughLoss;
  if (v === 'heavyTank') {
    m *= ARSENAL.heavy.loss;
    if (fortified || terrain === Terrain.Mountains) m *= has(pl(state, pid), 'siegeTanks') ? ARSENAL.siegeRoughLoss : ARSENAL.heavy.roughLoss;
  }
  if (has(pl(state, pid), 'mechInfantry')) m *= ARSENAL.mechSpearheadLoss;
  return m;
}
/** Defence x of holding divisions (light worse, heavy better). */
export function armorDefenseMul(state: GameState, pid: number): number {
  const v = armorVariantOf(state, pid);
  return v === 'lightTank' ? ARSENAL.light.defense : v === 'heavyTank' ? ARSENAL.heavy.defense : 1;
}
/** Refit speed x (Deep Raids). */
export function armorRefitMul(state: GameState, pid: number): number {
  return has(pl(state, pid), 'deepRaids') ? ARSENAL.deepRaidsRefit : 1;
}
/** Encirclement pocket size limit x (Armor Mastery). */
export function armorPocketMul(state: GameState, pid: number): number {
  return has(pl(state, pid), 'armorMastery') ? ARSENAL.armorMasteryPocket : 1;
}
/** Troops killed in a collapsing pocket x (Armor Mastery). */
export function armorPocketKillMul(state: GameState, pid: number): number {
  return has(pl(state, pid), 'armorMastery') ? ARSENAL.armorMasteryKill : 1;
}

/**
 * A spearhead of division u took tile t through a fort of `victim` (tanks.ts): Siege Tanks knock out the victim's forts
 * near t for siegeFortSeconds.
 */
export function onFortBreached(state: GameState, u: Unit, t: number, victim: number): void {
  if (victim <= 0 || !has(pl(state, u.owner), 'siegeTanks')) return;
  const w = state.map.width;
  const x = t % w;
  const y = (t / w) | 0;
  const until = state.tick + ARSENAL.siegeFortSeconds * TICKS_PER_SECOND;
  const r = ARSENAL.siegeFortReach;
  for (const b of buildingsOf(state, victim, 'fort')) {
    if (b.owner !== victim || b.buildLeft > 0) continue;
    if (d2(b.tile % w, (b.tile / w) | 0, x, y) <= r * r) b.disabledUntil = Math.max(b.disabledUntil, until);
  }
}

/**
 * A spearhead ended (tanks.ts endSpearhead, before the division steps back): with Mechanized infantry the land along
 * its line holds (a HoldZone over the line from launch to the head).
 */
export function onSpearheadDone(state: GameState, u: Unit, launch: number, headX: number, headY: number, taken: number): void {
  if (taken <= 0 || !has(pl(state, u.owner), 'mechInfantry')) return;
  const w = state.map.width;
  const lx = launch % w;
  const ly = (launch / w) | 0;
  const cx = Math.round((lx + headX) / 2);
  const cy = Math.round((ly + headY) / 2);
  const half = Math.sqrt(d2(lx, ly, headX, headY)) / 2;
  const radius = Math.min(ARSENAL.mechHoldMaxRadius, half + 3);
  arsenalState(state).holds.push({ owner: u.owner, tile: cy * w + cx, radius, untilTick: state.tick + ARSENAL.mechHoldSeconds * TICKS_PER_SECOND });
}

/** Defence x on attacks against `defender`'s tile from Mechanized-infantry hold zones (tanks.tankDefenseAt asks). */
export function holdDefenseAt(state: GameState, defender: number, tile: number): number {
  const a = state.arsenal;
  if (!a || !a.holds.length || defender <= 0) return 1;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  for (const z of a.holds) {
    if (z.owner !== defender || z.untilTick <= state.tick) continue;
    if (d2(z.tile % w, (z.tile / w) | 0, x, y) <= z.radius * z.radius) return ARSENAL.mechHoldDefense;
  }
  return 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Bombers (per-player path) and Air Mastery
// ---------------------------------------------------------------------------------------------------------------

/** Air wing size x (Air Mastery). */
export function airWingMul(state: GameState, pid: number): number {
  return has(pl(state, pid), 'airMastery') ? ARSENAL.airMasteryWing : 1;
}
/** Air wing mission reach x (heavy bombers). */
export function airRangeMul(state: GameState, pid: number): number {
  const v = airVariantOf(state, pid);
  return v ? ARSENAL[v].range : 1;
}
/** Support strike strength x (ground-attack planes better, heavy bombers worse). */
export function airSupportMul(state: GameState, pid: number): number {
  const v = airVariantOf(state, pid);
  return v ? ARSENAL[v].support : 1;
}
/** Strategic raid strength x (heavy bombers better, ground-attack worse). */
export function airRaidMul(state: GameState, pid: number): number {
  const v = airVariantOf(state, pid);
  return v ? ARSENAL[v].strategic : 1;
}
/** Extra hit points of a new bomber (heavy bombers). */
export function airBomberExtraHp(state: GameState, pid: number): number {
  const v = airVariantOf(state, pid);
  return v ? ARSENAL[v].hp : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Recon planes and reveals
// ---------------------------------------------------------------------------------------------------------------

function reconReadyTick(a: ArsenalState, airfieldId: number): number {
  for (let k = 0; k < a.reconReady.length; k += 2) if (a.reconReady[k] === airfieldId) return a.reconReady[k + 1];
  return 0;
}
function setReconReady(a: ArsenalState, airfieldId: number, tick: number): void {
  for (let k = 0; k < a.reconReady.length; k += 2) {
    if (a.reconReady[k] === airfieldId) {
      a.reconReady[k + 1] = tick;
      return;
    }
  }
  a.reconReady.push(airfieldId, tick);
}
/** Recon reach of an airfield (tiles). */
export function reconRange(b: Building): number {
  return ARSENAL.reconRange + ARSENAL.reconRangePerLevel * (Math.max(1, b.level) - 1);
}
/** Seconds until airfield b can fly recon again (0 = ready). */
export function reconCooldownLeft(state: GameState, b: Building): number {
  const a = state.arsenal;
  if (!a) return 0;
  return Math.max(0, (reconReadyTick(a, b.id) - state.tick) / TICKS_PER_SECOND);
}

function reconSite(state: GameState, pid: number, airfield: number, tile: number): Building | string {
  const w = state.map.width;
  const tx = tile % w;
  const ty = (tile / w) | 0;
  const check = (b: Building): string | null => {
    if (b.type !== 'airfield' || b.owner !== pid || b.buildLeft > 0) return 'Recon planes fly from a finished Airfield of yours';
    const left = reconCooldownLeft(state, b);
    if (left > 0) return `Recon plane ready in ${Math.ceil(left)} s`;
    const r = reconRange(b);
    if (d2(b.tile % w, (b.tile / w) | 0, tx, ty) > r * r) return 'Too far from the airfield';
    return null;
  };
  if (airfield !== -1) {
    const b = buildingAt(state, airfield);
    if (!b) return 'Recon planes fly from a finished Airfield of yours';
    return check(b) ?? b;
  }
  let best: Building | null = null;
  let bestD = Infinity;
  let why = 'You need a finished Airfield';
  for (const b of buildingsOf(state, pid, 'airfield')) {
    const r = check(b);
    if (r) {
      why = r;
      continue;
    }
    const d = d2(b.tile % w, (b.tile / w) | 0, tx, ty);
    if (d < bestD || (d === bestD && best !== null && b.id < best.id)) {
      best = b;
      bestD = d;
    }
  }
  return best ?? why;
}

/** Can playerId fly recon to tile now (Action reconFlight)? `airfield` = the airfield it would fly from. */
export function canReconFlight(state: GameState, pid: number, airfield: number, tile: number): ActionResult & { airfield?: number } {
  const p = pl(state, pid);
  if (!p || !p.alive) return FAIL('No such player');
  const ruled = unitRule(state, 'bomber');
  if (ruled) return FAIL(ruled);
  if (!has(p, 'reconPlanes')) return FAIL('Needs research: Recon Planes');
  const site = reconSite(state, pid, airfield, tile);
  if (typeof site === 'string') return FAIL(site);
  const c = UNITS.reconPlane;
  if (p.gold < c.gold) return FAIL(`Not enough gold (${c.gold})`);
  if (p.oil < c.oil) return FAIL(`Not enough oil (${c.oil})`);
  return { ok: true, airfield: site.tile };
}

/** Action reconFlight: a recon plane flies from the airfield to tile, reveals a circle there, then flies home. */
export function reconFlight(state: GameState, pid: number, airfield: number, tile: number): ActionResult {
  const r = canReconFlight(state, pid, airfield, tile);
  if (!r.ok) return r;
  const p = state.players[pid];
  const c = UNITS.reconPlane;
  p.gold -= c.gold;
  p.oil -= c.oil;
  const b = buildingAt(state, r.airfield!)!;
  setReconReady(arsenalState(state), b.id, state.tick + ARSENAL.reconCooldown * TICKS_PER_SECOND);
  const w = state.map.width;
  state.units.push({
    id: newId(state),
    type: 'reconPlane',
    owner: pid,
    x: b.tile % w,
    y: (b.tile / w) | 0,
    target: tile,
    home: b.tile,
    path: [],
    pathPos: 0,
    troops: { infantry: 0, armor: 0, artillery: 0 },
    hp: 1,
    cargo: 0,
    state: 0,
    targetOwner: state.map.owner[tile],
  });
  return { ok: true };
}

function moveToward(state: GameState, u: Unit, tile: number, speed: number): boolean {
  const w = state.map.width;
  const tx = tile % w;
  const ty = (tile / w) | 0;
  const dx = tx - u.x;
  const dy = ty - u.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const step = speed * TICK_SECONDS;
  if (d <= step) {
    u.x = tx;
    u.y = ty;
    return true;
  }
  u.x += (dx / d) * step;
  u.y += (dy / d) * step;
  return false;
}

function addReveal(state: GameState, owner: number, tile: number, radius: number, seconds: number, kind: number): void {
  const a = arsenalState(state);
  const until = state.tick + Math.round(seconds * TICKS_PER_SECOND);
  const w = state.map.width;
  // A screen (kind 2) moves with its division: refresh a near one instead of piling up circles.
  if (kind === 2) {
    for (const z of a.reveals) {
      if (z.owner !== owner || z.kind !== 2 || z.untilTick <= state.tick) continue;
      if (d2(z.tile % w, (z.tile / w) | 0, tile % w, (tile / w) | 0) <= (radius * radius) / 4) {
        z.tile = tile;
        z.untilTick = until;
        return;
      }
    }
  }
  a.reveals.push({ owner, tile, radius, untilTick: until, kind });
}

const intelCache = new WeakMap<GameState, { tick: number; n: number; seen: Map<number, Set<number>> }>();
/** Nations `viewer` has intel on through its active reveals (land or capital inside a circle). */
function revealedNations(state: GameState, viewer: number): Set<number> | undefined {
  const a = state.arsenal;
  if (!a || !a.reveals.length) return undefined;
  let c = intelCache.get(state);
  if (!c || c.tick !== state.tick || c.n !== a.reveals.length) {
    const seen = new Map<number, Set<number>>();
    const map = state.map;
    const w = map.width;
    for (const z of a.reveals) {
      if (z.untilTick <= state.tick) continue;
      let set = seen.get(z.owner);
      if (!set) seen.set(z.owner, (set = new Set()));
      const cx = z.tile % w;
      const cy = (z.tile / w) | 0;
      const r = Math.floor(z.radius);
      const r2 = z.radius * z.radius;
      for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y += 2) {
        for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x += 2) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
          const o = map.owner[y * w + x];
          if (o > 0 && o !== z.owner) set.add(o);
        }
      }
      for (const p of state.players) if (p.id > 0 && p.alive && p.capital >= 0 && d2(p.capital % w, (p.capital / w) | 0, cx, cy) <= r2) set.add(p.id);
    }
    c = { tick: state.tick, n: a.reveals.length, seen };
    intelCache.set(state, c);
  }
  return c.seen.get(viewer);
}
/** True while `viewer` has a reveal over `target`'s land or capital (buildings.hasIntel asks). */
export function revealIntel(state: GameState, viewer: number, target: number): boolean {
  if (viewer <= 0 || target <= 0 || viewer === target) return false;
  return revealedNations(state, viewer)?.has(target) ?? false;
}
/** Active reveal circles of a player (for a client overlay): kind 1 recon flight, 2 light-tank screen. */
export function revealsOf(state: GameState, viewer: number): { tile: number; radius: number; kind: number; secondsLeft: number }[] {
  const a = state.arsenal;
  if (!a) return [];
  return a.reveals
    .filter((z) => z.owner === viewer && z.untilTick > state.tick)
    .map((z) => ({ tile: z.tile, radius: z.radius, kind: z.kind, secondsLeft: (z.untilTick - state.tick) / TICKS_PER_SECOND }));
}
/** True when a recon flight to `target`'s land is worth it for the AI (a hostile nation, not at peace). */
export function reconWorthIt(state: GameState, pid: number, target: number): boolean {
  return target > 0 && hostile(state, pid, target) && peaceReason(state, pid, target) === null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tick and hash
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every tick (sim.ts, after the air wings): recon planes fly (reveal on arrival, home after); once a second: light-tank
 * screens refresh, division / bomber variant fields follow their owner's path, expired zones and timers are dropped.
 */
export function updateArsenal(state: GameState): void {
  for (const u of state.units) {
    if (u.type !== 'reconPlane' || u.hp <= 0) continue;
    if (!state.players[u.owner]?.alive) {
      u.hp = 0;
      continue;
    }
    if (u.state === 0) {
      if (moveToward(state, u, u.target, UNITS.reconPlane.speed)) {
        addReveal(state, u.owner, u.target, ARSENAL.reconRadius, ARSENAL.reconSeconds, 1);
        u.state = 1;
        const o = state.map.owner[u.target];
        if (state.players[u.owner].isHuman) {
          const where = o > 0 && o !== u.owner ? `over ${state.players[o].name}` : 'over the target';
          addEvent(state, 'info', `Recon plane ${where}: armies, buildings and doctrine revealed for ${ARSENAL.reconSeconds} s`, [u.owner], u.target);
        }
      }
    } else if (moveToward(state, u, u.home, UNITS.reconPlane.speed)) {
      u.hp = 0; // landed
    }
  }
  if (state.tick % TICKS_PER_SECOND !== 0) return;
  const w = state.map.width;
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (u.type === 'tankDivision') {
      const v = armorVariantOf(state, u.owner);
      if (u.variant !== v) u.variant = v;
      // Light tanks screen ahead of a running spearhead.
      if (v === 'lightTank' && u.state === 3) addReveal(state, u.owner, Math.round(u.y) * w + Math.round(u.x), ARSENAL.light.revealRadius, ARSENAL.light.revealSeconds, 2);
    } else if (u.type === 'bomber' && !u.variant) {
      const v = airVariantOf(state, u.owner);
      if (v) u.variant = v;
    }
  }
  const a = state.arsenal;
  if (!a) return;
  const live = (z: { owner: number; untilTick: number }): boolean => z.untilTick > state.tick && !!state.players[z.owner]?.alive;
  if (!a.reveals.every(live)) a.reveals = a.reveals.filter(live);
  if (!a.holds.every(live)) a.holds = a.holds.filter(live);
  if (a.reconReady.length) {
    const keep: number[] = [];
    for (let k = 0; k < a.reconReady.length; k += 2) if (a.reconReady[k + 1] > state.tick) keep.push(a.reconReady[k], a.reconReady[k + 1]);
    a.reconReady = keep;
  }
}

const VARIANT_CODE: Record<UnitVariant, number> = { destroyer: 1, battleship: 2, submarine: 3, carrier: 4, lightTank: 5, heavyTank: 6, groundAttack: 7, heavyBomber: 8 };

/** Hash of the arsenal state and the unit variants (hash.ts). */
export function hashArsenal(state: GameState, h: number, mixInt: (h: number, v: number) => number, mixFloat: (h: number, v: number) => number): number {
  for (const u of state.units) if (u.variant) h = mixInt(mixInt(h, u.id), VARIANT_CODE[u.variant]);
  for (const q of state.unitQueue ?? []) if (q.variant) h = mixInt(mixInt(h, q.id), VARIANT_CODE[q.variant]);
  const a = state.arsenal;
  if (!a) return h;
  h = mixInt(h, a.reveals.length);
  for (const z of a.reveals) {
    h = mixInt(h, z.owner);
    h = mixInt(h, z.tile);
    h = mixFloat(h, z.radius);
    h = mixInt(h, z.untilTick);
    h = mixInt(h, z.kind);
  }
  h = mixInt(h, a.holds.length);
  for (const z of a.holds) {
    h = mixInt(h, z.owner);
    h = mixInt(h, z.tile);
    h = mixFloat(h, z.radius);
    h = mixInt(h, z.untilTick);
  }
  h = mixInt(h, a.reconReady.length);
  for (const v of a.reconReady) h = mixInt(h, v);
  return h;
}
