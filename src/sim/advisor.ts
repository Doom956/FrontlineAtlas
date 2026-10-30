// The advisor: army mix and research choices shared by the AI nations and by players who leave them on auto
// (Player.auto, the default for humans, so a new player only has to click to attack), and plain-language hints for
// the human (suggestions()).
//
// recommendMix() is the AI's mix logic (personality base, then the main foe's mix, the terrain of the front, enemy
// forts, and what our oil and buildings allow). updateAdvisor() runs it, plus a default research order, for every
// player with auto flags on, every AUTO_MANAGE_SECONDS. suggestions() only reads the state.
import { artilleryOf, canBarrage } from './barrage';
import {
  armyTotalOf,
  buildingCost,
  buildingMaxLevel,
  buildingsOf,
  chargesReady,
  countBuildings,
  countSites,
  hasIntel,
  isDisabled,
  fortMultiplierAt,
  resolveBuildTarget,
  samRadius,
} from './buildings';
import { artillerySiegeBonus, supplyDistance } from './combat';
import {
  ARMOR_OIL_UPKEEP,
  AUTO_MANAGE_SECONDS,
  BARRAGE_MIN_ARTILLERY,
  BUILDINGS,
  DEFAULT_TECH_ORDER,
  OIL_PER_WELL,
  PARADROP_MIN_TROOPS,
  SUPPLY_RANGE,
  TECHS,
  TICKS_PER_SECOND,
} from './config';
import { areAllied } from './diplomacy';
import { alliancesAllowed, buildingAllowed, peaceActive, researchRule, unitAllowed } from './rules';
import { hasTech, startResearch } from './tech';
import { borderTiles, depositCount, ownedTilesOf } from './territory';
import { paradropRange } from './units';
import { Resource, isTribe, isWater } from './types';
import type { BuildingType, GameState, Player, TechId, Troops } from './types';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
function total(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}
/** Share of each troop type in a force (empty -> all infantry). */
export function troopShares(t: Troops): Troops {
  const tot = total(t);
  if (tot <= 0) return { infantry: 1, armor: 0, artillery: 0 };
  return { infantry: t.infantry / tot, armor: t.armor / tot, artillery: t.artillery / tot };
}

/** Mix the advisor starts from for players without a personality. */
export const ADVISOR_BASE_MIX = { armor: 0.25, artillery: 0.2 };
/** Gold kept back when the advisor starts research: it starts a tech when gold >= price x this. */
const RESEARCH_GOLD_MARGIN = 1.5;

/** Fraction of the sampled tiles that are open ground (plains/desert). */
export function openness(state: GameState, tiles: readonly number[]): number {
  if (!tiles.length) return 0.5;
  let open = 0;
  for (const t of tiles) {
    const ter = state.map.terrain[t];
    if (ter === 2 || ter === 6) open++;
  }
  return open / tiles.length;
}

/**
 * How fortified the sampled front tiles of `enemy` are, for artillery: 1 = all under a fort (the full siege bonus),
 * a watchtower's cover counts in part (combat.artillerySiegeBonus), 0 = open.
 */
export function fortifiedShare(state: GameState, enemy: number, tiles: readonly number[]): number {
  if (!tiles.length || countBuildings(state, enemy, 'fort') + countBuildings(state, enemy, 'watchtower') === 0) return 0;
  let f = 0;
  const k = Math.min(tiles.length, 8);
  const full = artillerySiegeBonus(1e9) - 1;
  for (let i = 0; i < k; i++) f += (artillerySiegeBonus(fortMultiplierAt(state, tiles[i], enemy)) - 1) / full;
  return f / k;
}

/** Share of an army of `army` units that the player's oil wells (plus ten minutes of the oil stock) keep running as armor. */
export function armorFedShare(state: GameState, p: Player, army: number): number {
  const wells = countBuildings(state, p.id, 'oilWell');
  const oilGross = wells * OIL_PER_WELL * (hasTech(p, 'industrialization') ? 1.25 : 1);
  const fed = (oilGross * 0.85) / ARMOR_OIL_UPKEEP + p.oil / (ARMOR_OIL_UPKEEP * 600);
  return fed / Math.max(1, army);
}

export interface MixAdvice {
  /** start from this mix (personality) */
  base: { armor: number; artillery: number };
  /** main foe (0 = none) */
  foe: number;
  /** some of the foe's tiles on our shared front (terrain and forts are read from them) */
  frontTiles: readonly number[];
  /** read the foe's mix, terrain and forts (false: base mix only) */
  careful: boolean;
  /** our whole army incl. deployed troops (for the oil limit) */
  army: number;
}

/**
 * Target armor / artillery shares: the base mix, then (careful) countering the foe's mix, the openness of the
 * front, and enemy forts; then what oil (armor upkeep) and our factories / arsenals allow. Never more than 55%
 * armor, 40% artillery.
 */
export function recommendMix(state: GameState, playerId: number, advice: MixAdvice): { armor: number; artillery: number } {
  const p = state.players[playerId];
  let armor = advice.base.armor;
  let artillery = advice.base.artillery;
  const foe = advice.foe;
  if (advice.careful && foe > 0 && state.players[foe]) {
    const theirs = troopShares(state.players[foe].troops);
    const front = advice.frontTiles;
    // Armor shines on open ground and against artillery (1.6); rough ground favours infantry and artillery.
    const open = openness(state, front);
    armor += (open - 0.5) * 0.5 + theirs.artillery * 0.2;
    artillery += (0.5 - open) * 0.15;
    // Artillery is strong against infantry (1.3) but weak against armor (0.7).
    artillery += (theirs.infantry - 0.6) * 0.15 - Math.max(0, theirs.armor - 0.3) * 0.4;
    // Against an armor-heavy foe our own armor (1.0) beats infantry (0.8) and artillery (0.7).
    if (theirs.armor > 0.35) armor += 0.1;
    // Forts (and, less, watchtowers) on their side of the front: artillery's siege bonus.
    artillery += fortifiedShare(state, foe, front) * 0.3;
  }
  // Armor burns oil: no more than the wells (plus a little stock) can feed. No factory / arsenal, no conversion.
  armor = Math.min(armor, armorFedShare(state, p, advice.army));
  if (countBuildings(state, playerId, 'factory', true) === 0) armor = Math.min(armor, 0.05);
  if (countBuildings(state, playerId, 'arsenal', true) === 0) artillery = Math.min(artillery, 0.05);
  return { armor: clamp(armor, 0, 0.55), artillery: clamp(artillery, 0, 0.4) };
}

/**
 * Next tech in `order` the player can research now (prerequisites met, not done or under way), or null. It does
 * not check gold.
 */
export function nextTechInOrder(p: Player, order: readonly TechId[]): TechId | null {
  for (const t of order) {
    if (hasTech(p, t) || p.researching === t) continue;
    if (!TECHS[t].requires.every((r) => hasTech(p, r))) continue;
    return t;
  }
  return null;
}

/**
 * The main foe of a player and some of its tiles touching ours: the target of our biggest attack on a nation,
 * else the nation attacking us hardest, else the neighbour with the biggest army. Samples the player's border set
 * (at most about 4000 border tiles); meant to run every few seconds, not every tick.
 */
export function mainFoe(state: GameState, playerId: number): { foe: number; frontTiles: number[] } {
  let foe = 0;
  let best = 0;
  for (const a of state.attacks) {
    if (a.attacker === playerId && a.target > 0 && total(a.troops) > best) {
      best = total(a.troops);
      foe = a.target;
    }
  }
  if (!foe) {
    for (const a of state.attacks) {
      if (a.target === playerId && a.attacker > 0 && total(a.troops) > best) {
        best = total(a.troops);
        foe = a.attacker;
      }
    }
  }
  const { list, len } = borderTiles(state, playerId);
  if (len === 0) return { foe, frontTiles: [] };
  const map = state.map;
  const { width: w, owner, terrain } = map;
  const n = owner.length;
  const stride = Math.max(1, Math.floor(len / 4000));
  const samples = new Map<number, number[]>();
  for (let k = 0; k < len; k += stride) {
    const i = list[k];
    const x = i % w;
    for (let d = 0; d < 4; d++) {
      const j = d === 0 ? (x > 0 ? i - 1 : -1) : d === 1 ? (x < w - 1 ? i + 1 : -1) : d === 2 ? i - w : i + w;
      if (j < 0 || j >= n) continue;
      const o = owner[j];
      if (o === 0 || o === playerId || isWater(terrain[j])) continue;
      let l = samples.get(o);
      if (!l) samples.set(o, (l = []));
      if (l.length < 24) l.push(j);
    }
  }
  if (!foe) {
    for (const [o, l] of samples) {
      const q = state.players[o];
      if (!q || !q.alive || l.length === 0) continue;
      const army = total(q.troops);
      if (army > best) {
        best = army;
        foe = o;
      }
    }
  }
  return { foe, frontTiles: foe ? (samples.get(foe) ?? []) : [] };
}

/** Army incl. troops in attacks, on transports and cargo planes. */
function wholeArmy(state: GameState, playerId: number): number {
  return armyTotalOf(state, playerId);
}

/**
 * Auto-manage for players with Player.auto flags (humans by default; staggered by id, every AUTO_MANAGE_SECONDS):
 * mix -> recommendMix against the main foe (careful), set directly (not through an action, so the flag stays on);
 * research -> when idle, the next tech of DEFAULT_TECH_ORDER once gold >= its price x 1.5.
 */
export function updateAdvisor(state: GameState): void {
  if (state.phase !== 'playing') return;
  const every = Math.max(1, Math.round(AUTO_MANAGE_SECONDS * TICKS_PER_SECOND));
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || !p.spawned || !p.auto) continue;
    if (!p.auto.mix && !p.auto.research) continue;
    if ((state.tick + p.id * 3) % every !== 0) continue;
    if (p.auto.mix) {
      const { foe, frontTiles } = mainFoe(state, p.id);
      const mix = recommendMix(state, p.id, { base: ADVISOR_BASE_MIX, foe, frontTiles, careful: true, army: wholeArmy(state, p.id) });
      if (Math.abs(mix.armor - p.armyMix.armor) > 0.02 || Math.abs(mix.artillery - p.armyMix.artillery) > 0.02) {
        p.armyMix = { armor: mix.armor, artillery: mix.artillery };
      }
    }
    if (p.auto.research && !p.researching) {
      const t = nextTechInOrder(p, DEFAULT_TECH_ORDER);
      if (t && p.gold >= TECHS[t].gold * RESEARCH_GOLD_MARGIN) startResearch(state, p.id, t);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hints for the human
// ---------------------------------------------------------------------------------------------------------------

/** One plain-language hint: what to do next and why. */
export interface Suggestion {
  /** stable key (the same hint keeps its id while it applies), e.g. 'build-city', 'attack-tribe-12' */
  id: string;
  text: string;
  /** where to look / click, if the hint is about a place */
  tile?: number;
  /** the building the hint is about (the client can preselect it) */
  building?: BuildingType;
  /** higher = more urgent */
  priority: number;
}

/** At most this many hints at once. */
export const MAX_SUGGESTIONS = 5;

/** Neighbours of a player read from its border set: border length (sampled) and a few tiles on both sides. */
interface Neighbour {
  /** border tiles counted (with the sampling stride) */
  edges: number;
  /** some of their tiles touching us */
  theirs: number[];
  /** some of our tiles touching them */
  ours: number[];
}
function neighbours(state: GameState, playerId: number): Map<number, Neighbour> {
  const out = new Map<number, Neighbour>();
  const { list, len } = borderTiles(state, playerId);
  if (len === 0) return out;
  const { width: w, owner, terrain } = state.map;
  const n = owner.length;
  const stride = Math.max(1, Math.floor(len / 3000));
  for (let k = 0; k < len; k += stride) {
    const i = list[k];
    const x = i % w;
    for (let d = 0; d < 4; d++) {
      const j = d === 0 ? (x > 0 ? i - 1 : -1) : d === 1 ? (x < w - 1 ? i + 1 : -1) : d === 2 ? i - w : i + w;
      if (j < 0 || j >= n || isWater(terrain[j])) continue;
      const o = owner[j];
      if (o === playerId) continue;
      let nb = out.get(o);
      if (!nb) out.set(o, (nb = { edges: 0, theirs: [], ours: [] }));
      nb.edges += stride;
      if (nb.theirs.length < 16) nb.theirs.push(j);
      if (nb.ours.length < 16 && nb.ours[nb.ours.length - 1] !== i) nb.ours.push(i);
    }
  }
  return out;
}

/** The tile about `k` steps from border tile `from` toward the capital, if we own it (else -1). */
function inwardOwn(state: GameState, playerId: number, from: number, k: number): number {
  const p = state.players[playerId];
  const w = state.map.width;
  if (p.capital < 0) return -1;
  const dx = (p.capital % w) - (from % w);
  const dy = ((p.capital / w) | 0) - ((from / w) | 0);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return p.capital;
  const s = Math.min(k, len) / len;
  const t = Math.round(((from / w) | 0) + dy * s) * w + Math.round((from % w) + dx * s);
  return state.map.owner[t] === playerId ? t : -1;
}

/** Where a build order of `type` near `tile` would go (resolveBuildTarget), or -1 if it can't be built there. */
function spotFor(state: GameState, playerId: number, type: BuildingType, tile: number): number {
  if (tile < 0) return -1;
  const r = resolveBuildTarget(state, playerId, type, tile);
  return 'error' in r ? -1 : r.tile;
}

/**
 * Plain-language next steps for a player (meant for the human; about 1 call per second): the most urgent first, at
 * most MAX_SUGGESTIONS. Pure: reads the state only (no RNG, no changes), so it is deterministic and safe to call from
 * the UI at any time. Ties are broken by id.
 */
export function suggestions(state: GameState, playerId: number): Suggestion[] {
  const p = state.players[playerId];
  if (!p || playerId <= 0 || !p.alive || !p.spawned || state.phase !== 'playing') return [];
  const out: Suggestion[] = [];
  // The game's modifiers: never suggest what is off (or an attack on a nation during peace time).
  const peace = peaceActive(state);
  const noResearch = researchRule(state) !== null;
  const noAlliances = !alliancesAllowed(state);
  const add = (id: string, text: string, priority: number, tile?: number, building?: BuildingType): void => {
    if (building && !buildingAllowed(state, building)) return;
    if (noResearch && id.startsWith('research-')) return;
    if (noAlliances && (id.startsWith('ally-') || id.startsWith('answer-'))) return;
    if (peace && (id === 'full-attack' || id === 'barrage' || id === 'paradrop')) return;
    if (id === 'paradrop' && !unitAllowed(state, 'paradrop')) return;
    const sg: Suggestion = { id, text, priority };
    if (tile !== undefined && tile >= 0) sg.tile = tile;
    if (building) sg.building = building;
    out.push(sg);
  };
  const home = total(p.troops);
  const cap = Math.max(1, p.maxPop);
  const fill = home / cap;
  const nbs = neighbours(state, playerId);
  const capital = p.capital;
  const name = (id: number): string => state.players[id]?.name ?? 'them';
  const canPay = (type: BuildingType, share = 1): boolean => {
    const c = buildingCost(state, playerId, type);
    return p.gold >= c.gold * share && p.iron >= c.iron * share;
  };

  // --- war and land -------------------------------------------------------------------------------------------
  let hardest = 0;
  let hardestTroops = 0;
  for (const a of state.attacks) {
    if (a.target !== playerId || a.attacker <= 0) continue;
    const t = total(a.troops);
    if (t > hardestTroops) {
      hardestTroops = t;
      hardest = a.attacker;
    }
  }
  if (hardest > 0) {
    const nb = nbs.get(hardest);
    if (hardestTroops > home * 0.8) {
      // A counter-attack is paid from the home troops that defend the border: against a bigger force, hold instead.
      add(`defend-${hardest}`, `${name(hardest)} attacks with more troops than you have at home: don't counter-attack (it spends your defenders), build forts there`, 95, nb?.ours[0], 'fort');
    } else {
      add(`counter-${hardest}`, `${name(hardest)} is attacking you: attack them back to stop their troops (this spends home troops)`, 95, nb?.theirs[0], undefined);
    }
  }
  // A neighbour with an army far bigger than our home troops can overrun us in seconds: say so early.
  let danger = 0;
  let dangerRatio = 2;
  for (const [o, nb] of nbs) {
    const op = state.players[o];
    if (o === 0 || !op || isTribe(op) || areAllied(state, playerId, o) || !nb.theirs.length) continue;
    const r = armyTotalOf(state, o) / Math.max(1, home);
    if (r > dangerRatio) {
      dangerRatio = r;
      danger = o;
    }
  }
  if (danger > 0 && danger !== hardest) {
    const ratio = dangerRatio >= 10 ? Math.round(dangerRatio) : Math.round(dangerRatio * 10) / 10;
    add(`danger-${danger}`, `DANGER: ${name(danger)}'s army is ${ratio}x your home troops. Keep troops home and build forts on that border`, 93, nbs.get(danger)!.ours[0], 'fort');
  }
  for (const r of state.allianceRequests) {
    if (r.to === playerId && state.players[r.from]?.alive) {
      add(`answer-${r.from}`, `${name(r.from)} asks for an alliance: accept it to secure that border`, 80);
      break;
    }
  }
  const wild = nbs.get(0);
  if (fill >= 0.8) {
    if (wild && wild.edges > 0) add('full-expand', 'Your troops are nearly full: expand into the wilderness', 90, wild.theirs[0]);
    else {
      let weakest = 0;
      let ratio = Infinity;
      for (const [o, nb] of nbs) {
        if (o === 0 || areAllied(state, playerId, o) || !nb.theirs.length) continue;
        const r = armyTotalOf(state, o) / Math.max(1, home);
        if (r < ratio) {
          ratio = r;
          weakest = o;
        }
      }
      if (weakest > 0) add('full-attack', `Your troops are full: attack! ${name(weakest)} is the weakest neighbour`, 90, nbs.get(weakest)!.theirs[0]);
    }
  }
  let tribe = 0;
  let tribeArmy = Infinity;
  for (const [o, nb] of nbs) {
    const q = state.players[o];
    if (o === 0 || !q?.alive || !isTribe(q) || areAllied(state, playerId, o) || !nb.theirs.length) continue;
    const a = armyTotalOf(state, o);
    if (a < home * 0.4 && a < tribeArmy) {
      tribeArmy = a;
      tribe = o;
    }
  }
  if (tribe > 0) add(`attack-tribe-${tribe}`, `${name(tribe)} next to you is weak: attack it`, 75, nbs.get(tribe)!.theirs[0]);

  // --- buildings ----------------------------------------------------------------------------------------------
  const cities = countSites(state, playerId, 'city', true);
  if (cities === 0) {
    add('build-city', 'Build a City: more troops and gold', 85, spotFor(state, playerId, 'city', capital), 'city');
  } else if (canPay('city', 0.8)) {
    if (cities < 1 + p.tiles / 2400) {
      add('build-city', 'Build another City: more troops and gold', 55, undefined, 'city');
    } else {
      const top = buildingMaxLevel('city');
      const c = buildingsOf(state, playerId, 'city').find((b) => b.buildLeft <= 0 && b.upgradeLeft <= 0 && b.level < top);
      if (c) add('upgrade-city', `Upgrade a City to level ${c.level + 1}: more troops and gold`, 45, c.tile, 'city');
    }
  }
  if (countBuildings(state, playerId, 'farm', true) < 1 + p.tiles / 3000 && canPay('farm', 0.8)) {
    let fertile = -1;
    for (const [, nb] of nbs) {
      for (const t of nb.ours) {
        if (state.map.resource[t] === Resource.Fertile) {
          fertile = t;
          break;
        }
      }
      if (fertile >= 0) break;
    }
    if (fertile >= 0) add('build-farm', 'Build a Farm on fertile land: twice the troops and growth', 50, spotFor(state, playerId, 'farm', fertile), 'farm');
    else add('build-farm', 'Build a Farm: more troops and faster growth', 46, spotFor(state, playerId, 'farm', capital), 'farm');
  }
  if (depositCount(state, playerId, 1) > 0 && countBuildings(state, playerId, 'mine', true) === 0) {
    const iron = ownedTilesOf(state, playerId, 'iron').find((t) => state.map.owner[t] === playerId) ?? -1;
    add('build-mine', 'You own iron: build a Mine (armor, artillery and forts need iron)', 60, spotFor(state, playerId, 'mine', iron), 'mine');
  }
  const wantsOil = countBuildings(state, playerId, 'factory', true) > 0 || hasTech(p, 'flight') || p.armyMix.armor > 0.1;
  if (wantsOil && depositCount(state, playerId, 2) > 0 && countBuildings(state, playerId, 'oilWell', true) === 0) {
    const oil = ownedTilesOf(state, playerId, 'oil').find((t) => state.map.owner[t] === playerId) ?? -1;
    add('build-oil', 'You own oil: build an Oil Well (armor and planes burn oil)', 55, spotFor(state, playerId, 'oilWell', oil), 'oilWell');
  }
  if (countBuildings(state, playerId, 'market', true) === 0 && cities > 0 && canPay('market')) {
    add('build-market', 'Build a Market: +12% gold', 35, spotFor(state, playerId, 'market', capital), 'market');
  }
  if (countBuildings(state, playerId, 'lab', true) === 0 && cities > 0 && canPay('lab')) {
    add('build-lab', 'Build a Research Lab: faster research', 33, spotFor(state, playerId, 'lab', capital), 'lab');
  }

  // --- the main foe -------------------------------------------------------------------------------------------
  const { foe, frontTiles } = mainFoe(state, playerId);
  const fp = foe > 0 ? state.players[foe] : undefined;
  if (fp && fp.alive && !isTribe(fp)) {
    if (hasIntel(state, playerId, foe) && troopShares(fp.troops).armor > 0.35) {
      add(`armor-${foe}`, `${fp.name} fields lots of armor: forts on hills, or more infantry in forests and swamps`, 52, undefined, 'fort');
    }
    if (countBuildings(state, foe, 'fort') > 0 && countBuildings(state, playerId, 'arsenal', true) === 0 && canPay('arsenal', 0.8)) {
      add('build-arsenal', `${fp.name} has forts: build an Arsenal, artillery beats forts`, 58, spotFor(state, playerId, 'arsenal', capital), 'arsenal');
    }
    // Supply: is most of the front beyond supply range?
    const range = SUPPLY_RANGE * (hasTech(p, 'logistics') ? 1.5 : 1);
    let far = 0;
    let k = 0;
    let farTile = -1;
    for (const t of frontTiles) {
      if (k >= 12) break;
      k++;
      if (supplyDistance(state, playerId, t) > range * 0.85) {
        far++;
        if (farTile < 0) farTile = t;
      }
    }
    if (k > 0 && far / k > 0.4 && farTile >= 0) {
      const ours = nbs.get(foe)?.ours ?? [];
      const anchor = ours.length ? inwardOwn(state, playerId, ours[0], 15) : -1;
      add('build-depot', 'Your front is far from supply: build a Supply Depot near it', 62, spotFor(state, playerId, 'supplyDepot', anchor), 'supplyDepot');
    }
    // Enemy planes or missiles and no SAM.
    if (hasTech(p, 'radar') && countBuildings(state, playerId, 'sam', true) === 0) {
      const air = buildingsOf(state, foe, 'silo').length > 0 || buildingsOf(state, foe, 'airfield').some((b) => b.bombers > 0);
      if (air) add('build-sam', `${fp.name} has bombers or missiles: build a SAM Site`, 57, spotFor(state, playerId, 'sam', capital), 'sam');
    }
  }

  // --- special abilities --------------------------------------------------------------------------------------
  if (artilleryOf(state, playerId) >= BARRAGE_MIN_ARTILLERY && p.barrageReadyTick <= state.tick) {
    let target = -1;
    let what = '';
    for (const [o, nb] of nbs) {
      if (o === 0 || areAllied(state, playerId, o) || !nb.theirs.length || target >= 0) continue;
      for (const b of [...buildingsOf(state, o, 'sam'), ...buildingsOf(state, o, 'fort')]) {
        if (b.buildLeft > 0 || isDisabled(state, b) || state.map.owner[b.tile] !== o) continue;
        if (!canBarrage(state, playerId, b.tile).ok) continue;
        target = b.tile;
        what = `${name(o)}'s ${BUILDINGS[b.type].name}`;
        break;
      }
    }
    if (target >= 0) add('barrage', `Shell ${what} with an artillery barrage before you attack`, 64, target);
  }
  if (fp && fp.alive && !isTribe(fp) && hasTech(p, 'flight') && fp.capital >= 0 && home > PARADROP_MIN_TROOPS * 10) {
    const w = state.map.width;
    for (const af of buildingsOf(state, playerId, 'airfield')) {
      if (af.buildLeft > 0 || af.dropCooldown > 0) continue;
      const r = paradropRange(af);
      const dx = (af.tile % w) - (fp.capital % w);
      const dy = ((af.tile / w) | 0) - ((fp.capital / w) | 0);
      if (dx * dx + dy * dy > r * r) continue;
      let covered = false;
      for (const s of buildingsOf(state, foe, 'sam')) {
        if (s.buildLeft > 0 || isDisabled(state, s) || chargesReady(s) < 1) continue;
        const sr = samRadius(s);
        const sx = (s.tile % w) - (fp.capital % w);
        const sy = ((s.tile / w) | 0) - ((fp.capital / w) | 0);
        if (sx * sx + sy * sy <= sr * sr) covered = true;
      }
      add('paradrop', covered
        ? `${fp.name}'s capital is under SAM cover: silence the SAM with a barrage, then drop paratroopers`
        : `Paratroopers are ready: drop them on ${fp.name}'s capital`, covered ? 40 : 47, fp.capital);
      break;
    }
  }

  // --- research and diplomacy ---------------------------------------------------------------------------------
  if (!p.researching && !p.auto.research) {
    const t = nextTechInOrder(p, DEFAULT_TECH_ORDER);
    if (t) add(`research-${t}`, `Research ${TECHS[t].name}: ${TECHS[t].description}`, 42);
  }
  let friend = 0;
  let friendScore = 0;
  for (const [o] of nbs) {
    const q = state.players[o];
    if (o === 0 || !q?.alive || q.isHuman || isTribe(q) || areAllied(state, playerId, o)) continue;
    if (state.allianceRequests.some((r) => r.from === playerId && r.to === o)) continue;
    const opinion = state.opinion[o]?.[playerId] ?? 0;
    const fightsFoe = foe > 0 && o !== foe && state.attacks.some((a) => (a.attacker === o && a.target === foe) || (a.attacker === foe && a.target === o));
    const score = opinion + (fightsFoe ? 40 : 0);
    if (opinion >= 20 && score > friendScore) {
      friendScore = score;
      friend = o;
    }
  }
  if (friend > 0) {
    const fightsFoe = friendScore - (state.opinion[friend]?.[playerId] ?? 0) >= 40;
    add(`ally-${friend}`, fightsFoe ? `Ally with ${name(friend)}: they are friendly and fight your enemy` : `Ally with ${name(friend)}: they like you`, fightsFoe ? 48 : 30);
  }

  out.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.length > MAX_SUGGESTIONS ? out.slice(0, MAX_SUGGESTIONS) : out;
}
