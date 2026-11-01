// AI use of the special upgrades (specials.ts), of Amphibious Tanks crossings and AI purchases of Arsenal items
// (procurement.ts: aiProcurePick / aiProcureAffordable; ai.ts economy() orders with applyAction 'procure').
//
// Purchases: Arsenal items are bought with gold + iron / oil instead of researched. The AI buys what its research order
// (aispending.aiTechOrder: committed pillar's path, upgrades and mastery right after their prerequisites, the rest in
// profile order) would have reached: an item once at most ARSENAL_PRICES.aiLookahead available Research-tab techs come
// before it (its committed pillar's path at once), at most aiMaxOrders on order, keeping aiIronReserve / aiOilReserve
// back for tank divisions, warships and bombers. ai.ts weighs the purchase against buildings and research for gold.
//
// Which special fits a nation (aiSpecialPick, best first; only once its core research is under way, one special per
// few techs):
//   Early Warning    anyone facing a large hostile air force (Radar first when it is missing)
//   Night Bombing    air-minded / air-committed nations with bombers, against strong SAMs and fighters (not when the
//                    defenders hold Early Warning)
//   Naval Mines      admirals and navy-committed nations with ports, when rivals have warships
//   Amphibious Tanks warlords and armor-committed nations whose coast faces narrow water (straits, lakes)
//   Drop Tanks       air-committed nations with two or more airfields
// specials.aiSpecialTechs ranks the situational fit; the personality / pillar rules here decide who wants which.
// Deterministic: state only (per-tick caches in WeakMaps, rebuilt from the state).
import { airMinded } from './airwings';
import { buildingsOf } from './buildings';
import { ARSENAL_PRICES, SPECIALS, TECHS } from './config';
import { arsenalPrice, canProcure, canProcureIgnoringCost } from './procurement';
import { aiPriorityArsenalTech } from './variantsAI';
import { arsenalItem, isArsenalTech, onOrder } from './arsenal';
import { areAllied } from './diplomacy';
import { atPeace } from './rules';
import { aiSpecialTechs, narrowWater, SPECIAL_TECHS } from './specials';
import { techStatus } from './techtree';
import { ownedTilesOf } from './territory';
import { isTribe, isWater } from './types';
import type { BuildingType, GameState, Player, TechId } from './types';
import { aiCommittedPillar } from './variantsAI';
import { pathOf } from './arsenal';
import type { Pillar } from './arsenal';
import { atWar } from './allies';

/** True once p owns the fork root it chose in that pillar. */
function pillarPathOwned(p: Player, pillar: Exclude<Pillar, 'shared'>): boolean {
  const t = pathOf(p, pillar);
  return !!t && p.techs.includes(t);
}

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** Specials an AI may hold by its research count: none before 6 techs, then one more per 4 techs (at most 3). */
function specialAllowance(techs: number): number {
  if (techs < 6) return 0;
  return Math.min(3, 1 + Math.floor((techs - 6) / 4));
}

const DIRS8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const shoreCache = new WeakMap<GameState, Map<number, { tick: number; v: number }>>();
/**
 * Own coast tiles (a sample of up to 300) that face narrow water with someone else's land across it within
 * amphibMaxWater + 1 tiles: how much an Amphibious Tanks crossing would open up. Cached for 30 s per nation.
 */
export function narrowShore(state: GameState, id: number): number {
  let m = shoreCache.get(state);
  if (!m) shoreCache.set(state, (m = new Map()));
  const c = m.get(id);
  if (c && state.tick - c.tick < 300) return c.v;
  let v = 0;
  const coast = ownedTilesOf(state, id, 'coast');
  const step = Math.max(1, Math.floor(coast.length / 300));
  for (let k = 0; k < coast.length; k += step) {
    const t = coast[k];
    if (state.map.owner[t] !== id) continue;
    if (acrossNarrow(state, id, t, -1) >= 0) v++;
  }
  m.set(id, { tick: state.tick, v });
  return v;
}

/**
 * From own land tile t: the first land tile across narrow water (all water between narrowWater, at most amphibMaxWater
 * of it) owned by `foe` (or, with foe -1, by any other nation that isn't allied), or -1.
 */
function acrossNarrow(state: GameState, id: number, t: number, foe: number): number {
  const map = state.map;
  const w = map.width;
  const h = map.height;
  const x0 = t % w;
  const y0 = (t / w) | 0;
  const N = SPECIALS.amphibMaxWater;
  for (const [dx, dy] of DIRS8) {
    let water = 0;
    for (let k = 1; k <= N + 1; k++) {
      const x = x0 + dx * k;
      const y = y0 + dy * k;
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      const q = y * w + x;
      if (isWater(map.terrain[q])) {
        if (!narrowWater(state, q)) break;
        water++;
        continue;
      }
      if (water === 0) break; // still on land: not a crossing in this direction
      const o = map.owner[q];
      if (o > 0 && o !== id && (foe < 0 ? !areAllied(state, id, o) : o === foe)) return q;
      break;
    }
  }
  return -1;
}

/**
 * An enemy land tile across narrow water from own coast, nearest to (fx, fy), for an Amphibious Tanks spearhead
 * against `foe` (-1 = none). Scans a sample of up to 400 own coast tiles.
 */
export function aiAmphibTarget(state: GameState, id: number, foe: number, fx: number, fy: number): number {
  const coast = ownedTilesOf(state, id, 'coast');
  const w = state.map.width;
  const step = Math.max(1, Math.floor(coast.length / 400));
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < coast.length; k += step) {
    const t = coast[k];
    if (state.map.owner[t] !== id) continue;
    const q = acrossNarrow(state, id, t, foe);
    if (q < 0) continue;
    const dx = (q % w) - fx;
    const dy = ((q / w) | 0) - fy;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d === bestD && q < best)) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * Air strength (airfields + bombers) and SAM / fighter cover of the nations AI id faces (non-allied neighbours and
 * nations at war with it), and whether one of them has Early Warning.
 */
function foeAir(state: GameState, id: number, enemies: readonly number[]): { air: number; cover: number; warn: boolean } {
  let air = 0;
  let cover = 0;
  let warn = false;
  for (const q of state.players) {
    if (q.id === 0 || q.id === id || !q.alive || isTribe(q) || !hostile(state, id, q.id)) continue;
    if (!enemies.includes(q.id) && !atWar(state, id, q.id)) continue;
    for (const b of buildingsOf(state, q.id, 'airfield')) {
      if (b.owner !== q.id) continue;
      air += 1 + b.bombers;
      cover += b.fighters;
    }
    cover += buildingsOf(state, q.id, 'sam').filter((b) => b.owner === q.id).length * 2;
    if (q.techs.includes('earlyWarning')) warn = true;
  }
  return { air, cover, warn };
}

function foeShips(state: GameState, id: number): number {
  let n = 0;
  for (const u of state.units) if (u.type === 'warship' && u.hp > 0 && u.owner !== id && hostile(state, id, u.owner)) n++;
  return n;
}

/**
 * The special (or its missing prerequisite) AI `id` researches next, or null: specials that fit its personality,
 * pillar and situation, ranked by specials.aiSpecialTechs and then by the list order below.
 */
export function aiSpecialPick(state: GameState, id: number, enemies: readonly number[] = []): TechId | null {
  const p = state.players[id];
  if (!p || !p.alive || p.isHuman || isTribe(p)) return null;
  const owned = SPECIAL_TECHS.filter((t) => p.techs.includes(t)).length;
  if (owned >= specialAllowance(p.techs.length)) return null;
  const pers = p.personality ?? 'balanced';
  const pillar = aiCommittedPillar(state, id);
  const air = airMinded(state, id) || pillar === 'air';
  const want: TechId[] = [];
  const fa = foeAir(state, id, enemies);
  const myAirfields = buildingsOf(state, id, 'airfield').filter((b) => b.owner === id);
  const bombers = myAirfields.reduce((n, b) => n + b.bombers, 0);
  // Anyone facing a big air force: Early Warning.
  if (fa.air >= 6) want.push('earlyWarning');
  // The rest only once the committed pillar's path is chosen (the variants come first: variantsAI.ts).
  if (pillarPathOwned(p, pillar)) {
    // Air nations against strong air defence: Night Bombing; with room to fly: Drop Tanks.
    if (air && (bombers >= 2 || myAirfields.length >= 2) && fa.cover >= 4 && !fa.warn) want.push('nightBombing');
    if (pillar === 'air' && myAirfields.length >= 2) want.push('dropTanks');
    // Admirals and navies: mines around the ports when rivals sail.
    if ((pers === 'admiral' || pillar === 'navy') && buildingsOf(state, id, 'port').some((b) => b.owner === id) && foeShips(state, id) > 0)
      want.push('navalMines');
    // Warlords and armor nations whose coast faces narrow water: Amphibious Tanks.
    if ((pers === 'warlord' || pillar === 'armor') && p.techs.includes('mechanization') && narrowShore(state, id) >= 4) want.push('amphibiousTanks');
  }
  if (!want.length) return null;
  const rank = aiSpecialTechs(state, id);
  want.sort((a, b) => {
    const ra = rank.indexOf(a);
    const rb = rank.indexOf(b);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || want.indexOf(a) - want.indexOf(b);
  });
  for (const t of want) {
    if (p.techs.includes(t)) continue;
    const st = techStatus(state, id, t);
    if (st === 'available') return t;
    if (st !== 'locked-prereq') continue;
    // One missing prerequisite that can be researched now (Radar for Early Warning, Fortification for Mines).
    for (const r of TECHS[t].requires) if (!p.techs.includes(r) && techStatus(state, id, r) === 'available') return r;
  }
  return null;
}

/** What an AI buys next from the Arsenal: the item (null = nothing now) and a building a wanted item still needs. */
export interface ProcurePick {
  tech: TechId | null;
  /** a wanted item waits for this building (Port, Factory, Airfield): ai.ts builds it sooner */
  needs?: BuildingType;
}

/**
 * The Arsenal item AI id buys next (prices not checked: see aiProcureAffordable). `first` = items wanted at once in this
 * order (situational picks from ai.ts: Navigation when boxed in, Flight against bombers, a special); `order` = the
 * nation's whole research order (aispending.aiTechOrder), `rejected` its rule for the rival side of a fork.
 */
export function aiProcurePick(
  state: GameState,
  id: number,
  first: readonly TechId[],
  order: readonly TechId[],
  skip: (t: TechId) => boolean,
): ProcurePick {
  const p = state.players[id];
  if (!p || !p.alive || isTribe(p)) return { tech: null };
  if ((p.procuring?.length ?? 0) >= ARSENAL_PRICES.aiMaxOrders) return { tech: null };
  let needs: BuildingType | undefined;
  const tryItem = (t: TechId): boolean => {
    if (p.techs.includes(t) || onOrder(p, t) || skip(t)) return false;
    const ok = canProcureIgnoringCost(state, id, t);
    if (ok.ok) return true;
    if (!needs) {
      const b = arsenalPrice(state, id, t).needs;
      if (b && ok.reason?.startsWith('Needs a')) needs = b;
    }
    return false;
  };
  for (const t of first) if (isArsenalTech(t) && tryItem(t)) return { tech: t, needs };
  let ahead = 0;
  for (const t of order) {
    if (p.techs.includes(t)) continue;
    if (!isArsenalTech(t)) {
      if (p.researching !== t && !skip(t) && techStatus(state, id, t) === 'available') ahead++;
      continue;
    }
    if (ahead > ARSENAL_PRICES.aiLookahead && !aiCommittedArsenal(state, id, t)) continue;
    if (tryItem(t)) return { tech: t, needs };
  }
  return { tech: null, needs };
}

/**
 * Arsenal items of the AI's committed pillar that it buys as soon as it can (no waiting for its research order): the
 * pillar's unlock, path, upgrades and (with a broad base) mastery, plus the shared unlock that fits it
 * (variantsAI.aiPriorityArsenalTech).
 */
export function aiCommittedArsenal(state: GameState, id: number, t: TechId): boolean {
  if (aiPriorityArsenalTech(state, id, t)) return true;
  const it = arsenalItem(t);
  return !!it && it.kind === 'unlock' && it.pillar !== 'shared' && it.pillar === aiCommittedPillar(state, id);
}

/** True if AI id can pay for t now and keep its iron / oil reserve for units. */
export function aiProcureAffordable(state: GameState, id: number, t: TechId): boolean {
  const p = state.players[id];
  if (!p || !canProcure(state, id, t).ok) return false;
  const price = arsenalPrice(state, id, t);
  if (price.iron > 0 && p.iron - price.iron < ARSENAL_PRICES.aiIronReserve) return false;
  if (price.oil > 0 && p.oil - price.oil < ARSENAL_PRICES.aiOilReserve) return false;
  return true;
}
