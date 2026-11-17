// AI use of the Arsenal (arsenal.ts, variants.ts): which fork a nation takes, where it spends its mastery, which
// warships it orders and when it flies recon. ai.ts / aispending.ts call in here; orders go through applyAction.
//
// - Forks (aiForkPick, used by aispending.aiBranchPick): a lean from what the nation and the map look like, plus a
//   per-game hash so both sides get played:
//     Navy   Silent service when rivals live off trade (many foreign trade ships and ports; merchants, admirals),
//            Surface fleet when there is enemy coast to shell (warlords, admirals with coastal neighbours).
//     Armor  Heavy tanks when rivals sit behind forts and mountains (turtles), Light tanks on open ground (warlords).
//     Air    Heavy bombers when rivals have many cities / factories in reach (merchants, air-minded), Ground-attack
//            for nations that mostly fight at their borders (warlords).
//     Defense Tank Traps when hostile rivals field many tank divisions, Flak Guns when they fly many bombers.
// - Defense is a second interest next to the committed pillar (aiDefenseCommitted): turtles, nations facing a hostile
//   threatening neighbour (fighting it, or DEFENSE.aiThreatBorder of its land border) with DEFENSE.aiStrongerNeighbour
//   x their army, and nations whose threatening neighbours hold DEFENSE.aiEnemyBombers bombers buy a Defense root as
//   soon as they can; others leave the row alone. Never at Easy (it stays simple).
// - Mastery only in the committed pillar (aiCommittedPillar: doctrine, then personality and map).
// - Warships: a battleship every third ship once it has Battleships, a carrier every fourth once it has Carriers.
// - Recon: every ARSENAL.reconCooldown + a bit, over the capital of the nation it fights hardest, when in reach.
// Deterministic: state and hashes only.
import { fogOn, fogReconAim, knownTile } from './fog';
import { applyAction } from './actions';
import { arsenalItem, isMasteryTech, ownsOrPending, pillarOf } from './arsenal';
import type { Pillar } from './arsenal';
import { buildingsOf } from './buildings';
import { ARSENAL, DEFENSE, TECHS, TICKS_PER_SECOND } from './config';
import { areAllied } from './diplomacy';
import { doctrineActive } from './doctrines';
import { borderTiles, coastCount } from './territory';
import { Terrain, isTribe, isWater } from './types';
import type { GameState, NavalVariant, Personality, TechId } from './types';
import { airMinded, fighterCoverOnRoute } from './airwings';
import { aiAttackLevel } from './aiattack';
import { canReconFlight, navalVariantsOf, reconRange, reconWorthIt } from './variants';
import { aiFocusSpec } from './aifocus';

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x6b43a9b5, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
function noise(state: GameState, id: number, salt: number): number {
  return mix(state.settings.seed * 131 + id, salt) - 0.5; // -0.5 .. 0.5
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function rivals(state: GameState, id: number): number[] {
  const out: number[] = [];
  for (const p of state.players) if (p.id > 0 && p.id !== id && p.alive && !isTribe(p)) out.push(p.id);
  return out;
}

const roughCache = new WeakMap<GameState, number>();
/** Share (0..1) of a sample of land tiles that are hills or mountains (terrain never changes: cached per game). */
function roughShare(state: GameState): number {
  let v = roughCache.get(state);
  if (v === undefined) roughCache.set(state, (v = roughShareOf(state)));
  return v;
}
function roughShareOf(state: GameState): number {
  const map = state.map;
  const n = map.width * map.height;
  const step = Math.max(1, Math.floor(n / 4000));
  let land = 0;
  let rough = 0;
  for (let i = 0; i < n; i += step) {
    const t = map.terrain[i];
    if (isWater(t)) continue;
    land++;
    if (t === Terrain.Mountains || t === Terrain.Hills) rough++;
  }
  return land ? rough / land : 0;
}

const leanCache = new WeakMap<GameState, Map<string, { win: number; v: number }>>();
/** forkLean, computed once per tick per nation and group (the AI asks many times in one decision). */
function forkLeanCached(state: GameState, id: number, group: string): number {
  let m = leanCache.get(state);
  if (!m) leanCache.set(state, (m = new Map()));
  const win = state.tick;
  const key = `${id}:${group}`;
  const c = m.get(key);
  if (c && c.win === win) return c.v;
  const v = forkLean(state, id, group);
  m.set(key, { win, v });
  return v;
}
/** Lean (0..1) toward the SECOND option of a fork for AI id: silent service, heavy tanks, heavy bombers. */
function forkLean(state: GameState, id: number, group: string): number {
  const p = state.players[id];
  const pers: Personality = p?.personality ?? 'balanced';
  const others = rivals(state, id);
  if (group === 'navalDoctrine') {
    let trade = 0;
    for (const u of state.units) if (u.type === 'tradeShip' && u.hp > 0 && u.owner !== id) trade++;
    let ports = 0;
    for (const o of others) ports += buildingsOf(state, o, 'port').length;
    let lean = 0.25 + 0.4 * (trade / (trade + 6)) + 0.15 * (ports / (ports + 8));
    if (pers === 'merchant') lean += 0.15;
    if (pers === 'warlord') lean -= 0.15;
    return lean;
  }
  if (group === 'armorPath') {
    let forts = 0;
    for (const o of others) forts += buildingsOf(state, o, 'fort').length;
    let lean = 0.2 + 0.35 * (forts / (forts + 6)) + 1.2 * roughShare(state);
    if (pers === 'turtle') lean += 0.2;
    if (pers === 'warlord') lean -= 0.15;
    return lean;
  }
  if (group === 'defenseDoctrine') {
    const f = foeForces(state, id);
    return 0.5 + 0.45 * (f.tanks / (f.tanks + 4)) - 0.45 * (f.bombers / (f.bombers + 6));
  }
  if (group === 'airDoctrine') {
    let econ = 0;
    for (const o of others) econ += buildingsOf(state, o, 'city').length + buildingsOf(state, o, 'factory').length;
    let lean = 0.25 + 0.35 * (econ / (econ + 20));
    if (pers === 'merchant' || airMinded(state, id)) lean += 0.15;
    if (pers === 'warlord' || pers === 'turtle') lean -= 0.15; // turtles fight at their own borders: front support
    return lean;
  }
  return 0.5;
}

/** Members of the arsenal forks: [first option, second option]. */
const FORKS: Record<string, [TechId, TechId]> = {
  navalDoctrine: ['destroyers', 'submarines'],
  armorPath: ['lightTanks', 'heavyTanks'],
  airDoctrine: ['groundAttack', 'heavyBombers'],
  defenseDoctrine: ['flakGuns', 'tankTraps'],
};

/** Tank divisions and bombers (stored and flying) of the nations hostile to id. */
function foeForces(state: GameState, id: number): { tanks: number; bombers: number } {
  let tanks = 0;
  let bombers = 0;
  const foe = (o: number): boolean => o !== id && o > 0 && !areAllied(state, id, o) && !isTribe(state.players[o]);
  for (const u of state.units) {
    if (u.hp <= 0 || !foe(u.owner)) continue;
    if (u.type === 'tankDivision') tanks++;
    else if (u.type === 'bomber' || u.type === 'stealthBomber') bombers++;
  }
  for (const o of rivals(state, id)) {
    if (!foe(o)) continue;
    for (const b of buildingsOf(state, o, 'airfield')) bombers += b.bombers;
  }
  return { tanks, bombers };
}

/**
 * Land neighbours of id with their share (0..1) of its sampled land-border tiles that touch another nation (a stride
 * over its border tiles), by id.
 */
function landNeighbourShares(state: GameState, id: number): [number, number][] {
  const { list, len } = borderTiles(state, id);
  const map = state.map;
  const w = map.width;
  const hits = new Map<number, number>();
  let total = 0;
  const step = Math.max(1, Math.floor(len / 200));
  const seen = new Set<number>();
  for (let k = 0; k < len; k += step) {
    const t = list[k];
    seen.clear();
    for (const n of [t - 1, t + 1, t - w, t + w]) {
      if (n < 0 || n >= map.owner.length) continue;
      const o = map.owner[n];
      if (o > 0 && o !== id) seen.add(o);
    }
    if (!seen.size) continue;
    total++;
    for (const o of seen) hits.set(o, (hits.get(o) ?? 0) + 1);
  }
  return [...hits].sort((a, b) => a[0] - b[0]).map(([o, n]) => [o, n / Math.max(1, total)]);
}

const defenseCache = new WeakMap<GameState, Map<number, { win: number; v: boolean }>>();
/**
 * True if AI id wants the Defense row (a Flak Guns or Tank Traps root; part 3 adds the mastery): it already chose one,
 * or (from Normal up, not a benchmark specialist) it is a turtle, faces a threatening neighbour (defenseWanted) with
 * DEFENSE.aiStrongerNeighbour x its army, or its threatening neighbours hold DEFENSE.aiEnemyBombers bombers. Re-judged
 * every 30 s.
 */
export function aiDefenseCommitted(state: GameState, id: number): boolean {
  const p = state.players[id];
  if (!p || !p.alive || isTribe(p)) return false;
  if (ownsOrPending(p, 'flakGuns') || ownsOrPending(p, 'tankTraps')) return true;
  if (state.settings.difficulty === 'easy' || aiFocusSpec(state, id)) return false;
  let m = defenseCache.get(state);
  if (!m) defenseCache.set(state, (m = new Map()));
  const win = Math.floor(state.tick / (30 * TICKS_PER_SECOND));
  const c = m.get(id);
  if (c && c.win === win) return c.v;
  const v = defenseWanted(state, id);
  m.set(id, { win, v });
  return v;
}
/**
 * Only neighbours that actually threaten count: a nation fighting us now (an attack either way), or a land neighbour
 * holding at least DEFENSE.aiThreatBorder of our land border. (On the World map a nation touches many nations along
 * short stretches of border, and every far rival's bombers counted: 60% of the AIs took Defense there.)
 */
function defenseWanted(state: GameState, id: number): boolean {
  const p = state.players[id];
  if (p.personality === 'turtle') return true;
  const army = p.troops.infantry + p.troops.armor + p.troops.artillery;
  const fighting = new Set<number>();
  for (const a of state.attacks) {
    if (a.attacker === id && a.target > 0) fighting.add(a.target);
    else if (a.target === id && a.attacker > 0) fighting.add(a.attacker);
  }
  // The World map: many neighbours and long wars, so a stronger one or a bomber fleet is nearly always about; there
  // the bar is higher and fewer of the nations that meet it take Defense (medium stays as it is).
  const m = state.settings.map;
  const world = m.kind === 'world' && m.id === 'world';
  const ratio = world ? DEFENSE.aiStrongerNeighbourWorld : DEFENSE.aiStrongerNeighbour;
  const bomberBar = world ? DEFENSE.aiEnemyBombersWorld : DEFENSE.aiEnemyBombers;
  const pass = world ? DEFENSE.aiWorldPass : -0.2;
  const threats = new Set<number>(fighting);
  for (const [o, share] of landNeighbourShares(state, id)) if (share >= DEFENSE.aiThreatBorder) threats.add(o);
  let bombers = 0;
  for (const o of [...threats].sort((a, b) => a - b)) {
    const q = state.players[o];
    if (!q?.alive || isTribe(q) || areAllied(state, id, o)) continue;
    const theirs = q.troops.infantry + q.troops.armor + q.troops.artillery;
    if (theirs >= ratio * Math.max(1, army)) return noise(state, id, 991) > pass;
    for (const b of buildingsOf(state, o, 'airfield')) bombers += b.bombers;
  }
  for (const u of state.units) if ((u.type === 'bomber' || u.type === 'stealthBomber') && u.hp > 0 && threats.has(u.owner)) bombers++;
  return bombers >= bomberBar && (!world || noise(state, id, 993) > pass);
}

/**
 * The fork root AI id takes in an arsenal group (null for another group): stable while the map looks the same, and
 * aiBranchPick sticks to it once researched.
 */
export function aiForkPick(state: GameState, id: number, group: string): TechId | null {
  const f = FORKS[group];
  if (!f) return null;
  let salt = 17;
  for (let k = 0; k < group.length; k++) salt = Math.imul(salt, 31) + group.charCodeAt(k);
  const v = clamp01(forkLeanCached(state, id, group) + 0.6 * noise(state, id, salt));
  return v >= 0.5 ? f[1] : f[0];
}

/** The pillar AI id commits to (its mastery goes there). */
export function aiCommittedPillar(state: GameState, id: number): Exclude<Pillar, 'shared'> {
  const p = state.players[id];
  const forced = aiFocusSpec(state, id)?.arms; // benchmark specialist (aifocus.ts)
  if (forced) return forced;
  // Sticky once committed: a mastery, else a path upgrade (Battleships, Siege Tanks, ...) names the pillar, so a coast
  // won or lost later doesn't move the nation's mastery elsewhere.
  if (p) {
    let up: Exclude<Pillar, 'shared'> | null = null;
    for (const t of [...p.techs, ...(p.researching ? [p.researching] : []), ...(p.procuring ?? []).map((o) => o.tech)]) {
      const it = arsenalItem(t);
      if (!it || it.pillar === 'shared' || it.pillar === 'defense') continue; // Defense is a second interest
      if (it.kind === 'mastery') return it.pillar;
      if (it.kind === 'variant' && it.tier >= 3 && !up) up = it.pillar;
    }
    if (up) return up;
  }
  const held = doctrineActive(state, id);
  if (held === 'naval') return 'navy';
  if (held === 'air' || airMinded(state, id)) return 'air';
  if (held === 'blitz') return 'armor';
  const coastal = coastCount(state, id) > 0;
  switch (p?.personality ?? 'balanced') {
    case 'admiral':
      return coastal ? 'navy' : 'air';
    case 'warlord':
      return 'armor';
    case 'merchant':
      return coastal ? 'navy' : 'air';
    case 'turtle':
      return 'air';
    default: {
      const opts: Exclude<Pillar, 'shared'>[] = coastal ? ['armor', 'air', 'navy'] : ['armor', 'air'];
      return opts[Math.floor((noise(state, id, 977) + 0.5) * opts.length) % opts.length];
    }
  }
}

/** True for arsenal techs AI id leaves alone: masteries outside its committed pillar. */
export function aiSkipsArsenalTech(state: GameState, id: number, t: TechId): boolean {
  if (pillarOf(t) === 'defense') return !aiDefenseCommitted(state, id);
  if (!isMasteryTech(t)) return false;
  return pillarOf(t) !== aiCommittedPillar(state, id);
}

/**
 * Arsenal techs AI id researches as soon as their prerequisites are in (aispending.aiTechOrder): the path, upgrades and
 * mastery of its committed pillar, plus the shared unlock that fits it (Mechanized infantry for armor, Recon for air).
 */
export function aiPriorityArsenalTech(state: GameState, id: number, t: TechId): boolean {
  const g = TECHS[t].exclusiveGroup;
  if (g && aiFocusSpec(state, id)?.group === g) return true; // benchmark specialist: its fork first (aifocus.ts)
  const it = arsenalItem(t);
  if (!it || it.kind === 'special') return false;
  // A mastery (the dearest tech) jumps the queue only once the nation has a broad base (else it starves the economy).
  if (it.kind === 'mastery' && (state.players[id]?.techs.length ?? 0) < ARSENAL.aiMasteryMinTechs) return false;
  if (it.pillar === 'defense') return aiDefenseCommitted(state, id); // a second interest (part 3: its mastery too)
  const pillar = aiCommittedPillar(state, id);
  if (it.pillar === pillar) return it.kind !== 'unlock';
  return (t === 'mechInfantry' && pillar === 'armor') || (t === 'reconPlanes' && pillar === 'air');
}

/** Arsenal techs the AI research order should weigh (variants, upgrades, masteries, shared unlocks; not specials). */
export function aiArsenalTech(t: TechId): boolean {
  const it = arsenalItem(t);
  return !!it && it.kind !== 'special' && TECHS[t].tier >= 3;
}

/** The warship variant AI id orders next (undefined = the default / standard ship). */
export function aiWarshipVariant(state: GameState, id: number): NavalVariant | undefined {
  const can = navalVariantsOf(state, id);
  if (!can.length) return undefined;
  const count: Record<string, number> = {};
  let ships = 0;
  for (const u of state.units) {
    if (u.type !== 'warship' || u.owner !== id || u.hp <= 0) continue;
    ships++;
    if (u.variant) count[u.variant] = (count[u.variant] ?? 0) + 1;
  }
  for (const q of state.unitQueue ?? []) {
    if (q.type !== 'warship' || q.owner !== id) continue;
    ships++;
    if (q.variant) count[q.variant] = (count[q.variant] ?? 0) + 1;
  }
  // About one ship in three a battleship, one in four a carrier (counting the new one).
  if (can.includes('battleship') && ((count.battleship ?? 0) + 1) * 3 <= ships + 1) return 'battleship';
  // Carriers only with an air force to fly from them (air wings launch from carriers: airwings.ts).
  const wings = buildingsOf(state, id, 'airfield').some((b) => b.owner === id && b.buildLeft <= 0);
  if (can.includes('carrier') && wings && ((count.carrier ?? 0) + 1) * 4 <= ships + 1) return 'carrier';
  return can.includes('destroyer') ? 'destroyer' : can.includes('submarine') ? 'submarine' : undefined;
}

const reconTick = new WeakMap<GameState, Map<number, number>>();

/**
 * Recon flight over the capital of the first nation in `fighting` that is in reach (ai.ts air turn). From Normal up
 * (aiattack.aiAttackLevel) the plane never flies through enemy fighter cover it knows of (airwings.fighterCoverOnRoute:
 * enemy fighters shoot recon planes down on their way out): it tries the capital, then the known buildings nearest
 * its airfields, then a fog aim, each from every airfield that reaches it, and flies the first clear route.
 */
export function aiRecon(state: GameState, id: number, fighting: readonly number[]): void {
  const p = state.players[id];
  if (!p || !p.alive || p.isHuman || isTribe(p) || !p.techs.includes('reconPlanes') || !fighting.length) return;
  let m = reconTick.get(state);
  if (!m) reconTick.set(state, (m = new Map()));
  if ((m.get(id) ?? 0) > state.tick) return;
  const w = state.map.width;
  const fields = buildingsOf(state, id, 'airfield').filter((b) => b.owner === id && b.buildLeft <= 0);
  if (!fields.length) return;
  const careful = aiAttackLevel(state) >= 1;
  let guarded = false;
  for (const foe of fighting) {
    const fp = state.players[foe];
    if (!fp?.alive || !reconWorthIt(state, id, foe)) continue;
    // Its capital if in reach, else its building nearest one of our airfields (within recon reach). Fog of war
    // (fog.ts): only a capital or building it knows; else a known front tile pushed one recon radius inward.
    const aims: number[] = [];
    if (fp.capital >= 0 && knownTile(state, id, fp.capital) && canReconFlight(state, id, -1, fp.capital).ok) aims.push(fp.capital);
    const near: { tile: number; d: number }[] = [];
    for (const b of buildingsOf(state, foe)) {
      if (b.owner !== foe || !knownTile(state, id, b.tile)) continue;
      let bestD = Infinity;
      for (const f of fields) {
        const dx = (b.tile % w) - (f.tile % w);
        const dy = ((b.tile / w) | 0) - ((f.tile / w) | 0);
        const d = dx * dx + dy * dy;
        const r = reconRange(f);
        if (d <= r * r && d < bestD) bestD = d;
      }
      if (bestD < Infinity) near.push({ tile: b.tile, d: bestD });
    }
    near.sort((a, b) => a.d - b.d || a.tile - b.tile);
    for (const c of near.slice(0, careful ? 6 : 1)) if (!aims.includes(c.tile)) aims.push(c.tile);
    if ((!aims.length || careful) && fogOn(state)) {
      const t = fogReconAim(state, id, foe);
      if (t >= 0 && !aims.includes(t)) aims.push(t);
    }
    for (const aim of careful ? aims : aims.slice(0, 1)) {
      if (!careful) {
        if (applyAction(state, id, { type: 'reconFlight', airfield: -1, tile: aim }).ok) {
          m.set(id, state.tick + Math.round((ARSENAL.reconCooldown + 15) * TICKS_PER_SECOND));
          return;
        }
        continue;
      }
      // Nearest airfield first; only a route clear of known enemy fighters.
      const dd = (t: number): number => {
        const dx = (t % w) - (aim % w);
        const dy = ((t / w) | 0) - ((aim / w) | 0);
        return dx * dx + dy * dy;
      };
      const order = [...fields].sort((a, b) => dd(a.tile) - dd(b.tile) || a.id - b.id);
      for (const f of order) {
        if (!canReconFlight(state, id, f.tile, aim).ok) continue;
        if (fighterCoverOnRoute(state, id, f.tile, aim) > 0) {
          guarded = true;
          continue;
        }
        if (applyAction(state, id, { type: 'reconFlight', airfield: f.tile, tile: aim }).ok) {
          m.set(id, state.tick + Math.round((ARSENAL.reconCooldown + 15) * TICKS_PER_SECOND));
          return;
        }
      }
    }
  }
  // Nothing in reach (or every route guarded by enemy fighters): look again later.
  m.set(id, state.tick + (guarded ? 20 : 10) * TICKS_PER_SECOND);
}
