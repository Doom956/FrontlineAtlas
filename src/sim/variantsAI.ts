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
// - Mastery only in the committed pillar (aiCommittedPillar: doctrine, then personality and map).
// - Warships: a battleship every third ship once it has Battleships, a carrier every fourth once it has Carriers.
// - Recon: every ARSENAL.reconCooldown + a bit, over the capital of the nation it fights hardest, when in reach.
// Deterministic: state and hashes only.
import { applyAction } from './actions';
import { arsenalItem, isMasteryTech, pillarOf } from './arsenal';
import type { Pillar } from './arsenal';
import { buildingsOf } from './buildings';
import { ARSENAL, TECHS, TICKS_PER_SECOND } from './config';
import { doctrineActive } from './doctrines';
import { coastCount } from './territory';
import { Terrain, isTribe, isWater } from './types';
import type { GameState, NavalVariant, Personality, TechId } from './types';
import { airMinded } from './airwings';
import { canReconFlight, navalVariantsOf, reconRange, reconWorthIt } from './variants';

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
};

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
  // Sticky once committed: a mastery, else a path upgrade (Battleships, Siege Tanks, ...) names the pillar, so a coast
  // won or lost later doesn't move the nation's mastery elsewhere.
  if (p) {
    let up: Exclude<Pillar, 'shared'> | null = null;
    for (const t of p.researching ? [...p.techs, p.researching] : p.techs) {
      const it = arsenalItem(t);
      if (!it || it.pillar === 'shared') continue;
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
  if (!isMasteryTech(t)) return false;
  return pillarOf(t) !== aiCommittedPillar(state, id);
}

/**
 * Arsenal techs AI id researches as soon as their prerequisites are in (aispending.aiTechOrder): the path, upgrades and
 * mastery of its committed pillar, plus the shared unlock that fits it (Mechanized infantry for armor, Recon for air).
 */
export function aiPriorityArsenalTech(state: GameState, id: number, t: TechId): boolean {
  const it = arsenalItem(t);
  if (!it || it.kind === 'special') return false;
  // A mastery (the dearest tech) jumps the queue only once the nation has a broad base (else it starves the economy).
  if (it.kind === 'mastery' && (state.players[id]?.techs.length ?? 0) < ARSENAL.aiMasteryMinTechs) return false;
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

/** Recon flight over the capital of the first nation in `fighting` that is in reach (ai.ts air turn). */
export function aiRecon(state: GameState, id: number, fighting: readonly number[]): void {
  const p = state.players[id];
  if (!p || !p.alive || p.isHuman || isTribe(p) || !p.techs.includes('reconPlanes') || !fighting.length) return;
  let m = reconTick.get(state);
  if (!m) reconTick.set(state, (m = new Map()));
  if ((m.get(id) ?? 0) > state.tick) return;
  const w = state.map.width;
  const fields = buildingsOf(state, id, 'airfield').filter((b) => b.owner === id && b.buildLeft <= 0);
  if (!fields.length) return;
  for (const foe of fighting) {
    const fp = state.players[foe];
    if (!fp?.alive || !reconWorthIt(state, id, foe)) continue;
    // Its capital if in reach, else its building nearest one of our airfields (within recon reach).
    let aim = fp.capital >= 0 && canReconFlight(state, id, -1, fp.capital).ok ? fp.capital : -1;
    if (aim < 0) {
      let bestD = Infinity;
      for (const b of buildingsOf(state, foe)) {
        if (b.owner !== foe) continue;
        for (const f of fields) {
          const dx = (b.tile % w) - (f.tile % w);
          const dy = ((b.tile / w) | 0) - ((f.tile / w) | 0);
          const d = dx * dx + dy * dy;
          const r = reconRange(f);
          if (d <= r * r && (d < bestD || (d === bestD && b.tile < aim))) {
            bestD = d;
            aim = b.tile;
          }
        }
      }
    }
    if (aim < 0) continue;
    if (applyAction(state, id, { type: 'reconFlight', airfield: -1, tile: aim }).ok) {
      m.set(id, state.tick + Math.round((ARSENAL.reconCooldown + 15) * TICKS_PER_SECOND));
      return;
    }
  }
  m.set(id, state.tick + 10 * TICKS_PER_SECOND); // nothing in reach: look again later
}
