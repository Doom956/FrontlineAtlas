// Doctrines (DESIGN section "Doctrines"): a mid-game, switchable, bonus-only specialisation.
//
// - Unlocks for everyone DOCTRINE_UNLOCK_SECONDS after the start of play (0:00), so the choice can react to the map,
//   the neighbours and the economy. Tribes never get one.
// - Bonus only: nothing is forbidden; each doctrine raises a few levers (config DOCTRINE_LEVERS) by about 15% at
//   level 1 and 25% at level 2, and adds one small signature perk at level 3 (DOCTRINE_PERKS).
// - Grows: levels 1 / 2 / 3 at DOCTRINE_LEVEL_SECONDS of holding the same doctrine (a switch starts again at 1).
// - Switchable: the first choice is free and works at once; a switch costs doctrineSwitchCost gold, gives no bonus
//   for DOCTRINE_ADAPT_SECONDS, and choices are DOCTRINE_SWITCH_COOLDOWN apart.
// Every timer counts game time and runs x2 in a fast game (rules.progressRate), like construction and research.
//
// The sim systems ask doctrineLever (a lever's bonus fraction, 0 without that doctrine) and doctrinePerk (level-3
// perk active). All state is Player.doctrine (hashed); changes only through the 'chooseDoctrine' action.
import { areAllied } from './diplomacy';
import { countBuildings, buildingsOf, hasIntel } from './buildings';
import {
  DOCTRINE_ADAPT_SECONDS,
  DOCTRINE_LEVEL_SECONDS,
  DOCTRINE_LEVEL_STRENGTH,
  DOCTRINE_LEVERS,
  DOCTRINE_PERKS,
  DOCTRINE_SWITCH_COOLDOWN,
  DOCTRINE_SWITCH_GOLD,
  DOCTRINE_SWITCH_INCOME_SECONDS,
  DOCTRINE_UNLOCK_SECONDS,
  DOCTRINES,
  TICKS_PER_SECOND,
} from './config';
import type { DoctrineLever } from './config';
import { mods, progressRate } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { borderTiles, coastCount, depositCount } from './territory';
import { DOCTRINE_IDS, Terrain, isTribe } from './types';
import type { ActionResult, DoctrineId, GameState, Player } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

// ------------------------------------------------------------------------------------------------ timing

/** Ticks a doctrine timer of `seconds` game seconds lasts in this game (fast game: half). */
export function doctrineTicks(state: GameState, seconds: number): number {
  return Math.round((seconds * TICKS_PER_SECOND) / progressRate(state));
}
/** Game seconds (the clock the player sees) at which doctrines unlock. */
export function doctrineUnlockSeconds(state: GameState): number {
  return doctrineTicks(state, DOCTRINE_UNLOCK_SECONDS) / TICKS_PER_SECOND;
}
/** Tick at which doctrines unlock (only meaningful once play started). */
export function doctrineUnlockTick(state: GameState): number {
  return state.playStartTick + doctrineTicks(state, DOCTRINE_UNLOCK_SECONDS);
}
/** "5:00" */
function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function nation(state: GameState, pid: number): Player | null {
  const p = state.players[pid];
  return p && pid > 0 && !isTribe(p) ? p : null;
}

/** True once pid may pick a doctrine: a nation (not a tribe), game time past the unlock. */
export function doctrineUnlocked(state: GameState, pid: number): boolean {
  if (!nation(state, pid) || state.phase === 'spawn') return false;
  return state.tick >= doctrineUnlockTick(state);
}

/** The doctrine whose bonuses apply now: null without one and while adapting after a switch. */
export function doctrineActive(state: GameState, pid: number): DoctrineId | null {
  const d = state.players[pid]?.doctrine;
  if (!d || d.id === null || state.tick < d.adaptUntilTick) return null;
  return d.id;
}

/** Level of the held doctrine (0 = none). Counts while adapting too (the bonus waits, the clock doesn't). */
export function doctrineLevel(state: GameState, pid: number): 0 | 1 | 2 | 3 {
  const d = state.players[pid]?.doctrine;
  return d && d.id !== null ? d.level : 0;
}

/** Level a doctrine chosen at chosenTick has reached by `tick`. */
function levelAt(state: GameState, chosenTick: number, tick: number): 1 | 2 | 3 {
  const held = tick - chosenTick;
  if (held >= doctrineTicks(state, DOCTRINE_LEVEL_SECONDS[2])) return 3;
  if (held >= doctrineTicks(state, DOCTRINE_LEVEL_SECONDS[1])) return 2;
  return 1;
}
/** Seconds until the held doctrine's next level (null at level 3 or without one). */
export function doctrineNextLevelIn(state: GameState, pid: number): number | null {
  const d = state.players[pid]?.doctrine;
  if (!d || d.id === null || d.level >= 3) return null;
  const at = d.chosenTick + doctrineTicks(state, DOCTRINE_LEVEL_SECONDS[d.level as 1 | 2]);
  return Math.max(0, (at - state.tick) / TICKS_PER_SECOND);
}
/** Seconds until pid may choose again (switch cooldown; 0 = now). */
export function doctrineCooldownLeft(state: GameState, pid: number): number {
  const d = state.players[pid]?.doctrine;
  if (!d || d.lastSwitchTick < 0) return 0;
  return Math.max(0, (d.lastSwitchTick + doctrineTicks(state, DOCTRINE_SWITCH_COOLDOWN) - state.tick) / TICKS_PER_SECOND);
}
/** Seconds of adaptation left after a switch (0 = the bonus applies). */
export function doctrineAdaptLeft(state: GameState, pid: number): number {
  const d = state.players[pid]?.doctrine;
  if (!d || d.id === null) return 0;
  return Math.max(0, (d.adaptUntilTick - state.tick) / TICKS_PER_SECOND);
}

/**
 * Gold a choice costs now: 0 for the first one, then DOCTRINE_SWITCH_GOLD or DOCTRINE_SWITCH_INCOME_SECONDS of the
 * player's gold income, whichever is more (a switch stays a real decision as the economy grows).
 */
export function doctrineSwitchCost(state: GameState, pid: number): number {
  const p = state.players[pid];
  if (!p || p.doctrine.id === null) return 0;
  return Math.round(Math.max(DOCTRINE_SWITCH_GOLD, DOCTRINE_SWITCH_INCOME_SECONDS * Math.max(0, p.income.gold)));
}

// ------------------------------------------------------------------------------------------------ lookups

/** Bonus fraction of a lever for pid now (0 without that doctrine or while adapting), e.g. 0.15 = +15%. */
export function doctrineLever(state: GameState, pid: number, lever: DoctrineLever): number {
  const id = doctrineActive(state, pid);
  if (id === null) return 0;
  const v = DOCTRINE_LEVERS[id][lever];
  return v === undefined ? 0 : v * DOCTRINE_LEVEL_STRENGTH[state.players[pid].doctrine.level];
}
/** True when pid's doctrine `id` is active at level 3 (its signature perk). */
export function doctrinePerk(state: GameState, pid: number, id: DoctrineId): boolean {
  return doctrineActive(state, pid) === id && state.players[pid].doctrine.level >= 3;
}
/** 1 + lever: for 'more' levers (speed, attack, gold). */
export function doctrineMore(state: GameState, pid: number, lever: DoctrineLever): number {
  return 1 + doctrineLever(state, pid, lever);
}
/** 1 - lever (never below 0.1): for 'less' levers (costs, losses, cooldowns). */
export function doctrineLess(state: GameState, pid: number, lever: DoctrineLever): number {
  return Math.max(0.1, 1 - doctrineLever(state, pid, lever));
}

/** Expansion: share of smallGrowth that applies at pid's size (1 while small, fading to 0 at smallShare[1]). */
export function smallNationFactor(state: GameState, pid: number): number {
  const p = state.players[pid];
  if (!p) return 0;
  const share = p.tiles / Math.max(1, state.map.landTileCount);
  const [full, none] = DOCTRINE_PERKS.expansion.smallShare;
  if (share <= full) return 1;
  if (share >= none) return 0;
  return (none - share) / (none - full);
}

// ------------------------------------------------------------------------------------------------ choosing

/** Validates and applies a doctrine choice (Action 'chooseDoctrine'). */
export function chooseDoctrine(state: GameState, pid: number, id: DoctrineId): ActionResult {
  const p = state.players[pid];
  if (!p || pid === 0) return FAIL('No such player');
  if (!DOCTRINE_IDS.includes(id)) return FAIL('Unknown doctrine');
  if (isTribe(p)) return FAIL('Tribes have no doctrines');
  if (!doctrineUnlocked(state, pid)) return FAIL(`Doctrines unlock at ${clock(doctrineUnlockSeconds(state))}`);
  const d = p.doctrine;
  if (d.id === id) return FAIL(`${DOCTRINES[id].name} is already your doctrine`);
  const wait = doctrineCooldownLeft(state, pid);
  if (wait > 0) return FAIL(`You can change doctrine again in ${clock(wait)}`);
  const cost = doctrineSwitchCost(state, pid);
  if (p.gold < cost) return FAIL(`Not enough gold (${cost})`);
  const first = d.id === null;
  const prev = d.id;
  p.gold -= cost;
  d.id = id;
  d.level = 1;
  d.chosenTick = state.tick;
  d.adaptUntilTick = first ? state.tick : state.tick + doctrineTicks(state, DOCTRINE_ADAPT_SECONDS);
  d.lastSwitchTick = state.tick;
  const info = DOCTRINES[id];
  const own = first
    ? `${info.name} doctrine adopted: ${info.levels[0]}`
    : `Switching to the ${info.name} doctrine: no doctrine bonus for ${clock(DOCTRINE_ADAPT_SECONDS / progressRate(state))} while your nation adapts`;
  addEvent(state, 'doctrineChosen', own, [pid], p.capital);
  const viewers = doctrineViewers(state, pid);
  if (viewers.length) {
    const news = first ? `${p.name} adopted the ${info.name} doctrine` : `${p.name} switched from ${DOCTRINES[prev!].name} to the ${info.name} doctrine`;
    addEvent(state, 'doctrineChosen', news, viewers, p.capital);
  }
  return { ok: true };
}

/** Other humans who can see pid's choice: they border it, are allied with it or have watchtower intel on it. */
function doctrineViewers(state: GameState, pid: number): number[] {
  const out: number[] = [];
  let neighbours: Set<number> | null = null;
  for (const h of state.players) {
    if (!h.isHuman || !h.alive || h.id === pid) continue;
    neighbours ??= borderOwners(state, pid);
    if (neighbours.has(h.id) || hasIntel(state, h.id, pid)) out.push(h.id);
  }
  return out;
}
const NB = [0, 0, 0, 0];
/** Owners (other than pid, incl. 0) of land next to pid's border. */
function borderOwners(state: GameState, pid: number): Set<number> {
  const out = new Set<number>();
  const { list, len } = borderTiles(state, pid);
  const { owner, width: w, terrain } = state.map;
  for (let k = 0; k < len; k++) {
    const n = nb4(list[k], w, owner.length);
    for (let q = 0; q < n; q++) {
      const j = NB[q];
      if (terrain[j] > 1 && owner[j] !== pid) out.add(owner[j]);
    }
  }
  return out;
}
function nb4(i: number, w: number, n: number): number {
  let c = 0;
  const x = i % w;
  if (x > 0) NB[c++] = i - 1;
  if (x < w - 1) NB[c++] = i + 1;
  if (i >= w) NB[c++] = i - w;
  if (i < n - w) NB[c++] = i + w;
  return c;
}

/** One tick: the unlock announcement and level-ups ('doctrineLevelUp'). Called by sim.tick while playing. */
export function updateDoctrines(state: GameState): void {
  if (state.phase !== 'playing') return;
  if (state.tick === doctrineUnlockTick(state)) {
    const humans = state.players.filter((p) => p.isHuman && p.alive).map((p) => p.id);
    if (humans.length) addEvent(state, 'doctrineUnlocked', 'Doctrines are unlocked: pick one to specialise your nation (you can switch later)', humans, -1);
  }
  for (const p of state.players) {
    const d = p.doctrine;
    if (d.id === null || d.level >= 3 || !p.alive) continue;
    const lv = levelAt(state, d.chosenTick, state.tick);
    if (lv <= d.level) continue;
    d.level = lv;
    addEvent(state, 'doctrineLevelUp', `${DOCTRINES[d.id].name} doctrine reached level ${lv}: ${DOCTRINES[d.id].levels[lv - 1]}`, [p.id], -1);
  }
}

// ------------------------------------------------------------------------------------------------ advice

/** What a player's situation says about each doctrine (deterministic: no RNG, so the client may call it). */
export interface DoctrineAdvice {
  id: DoctrineId;
  /** how well the doctrine fits (about 0..2.5; only the order matters) */
  score: number;
  /** a plain reason from the player's situation */
  reason: string;
}

/** Border and economy facts recommendDoctrines judges. */
interface Situation {
  tiles: number;
  landShare: number;
  coastShare: number;
  /** foreign land next to our border: neutral, tribe and nation tiles (sampled) */
  neutral: number;
  tribe: number;
  nationTiles: number;
  /** plains / desert among those */
  open: number;
  /** non-allied nations we border, by sampled border tiles */
  nations: Map<number, number>;
  /** the biggest of them by land, and its land / ours */
  bigId: number;
  bigRatio: number;
  /** finished forts of bordering non-allied nations */
  enemyForts: number;
  ports: number;
  markets: number;
  oil: number;
  airfields: number;
  flight: boolean;
  /** hostile warships or transports near us, or our transports at sea against a nation */
  seaWar: number;
  artilleryShare: number;
}

const MAX_BORDER_SAMPLES = 1500;

function situation(state: GameState, pid: number): Situation {
  const p = state.players[pid];
  const map = state.map;
  const { owner, terrain, width: w } = map;
  const s: Situation = {
    tiles: p.tiles,
    landShare: p.tiles / Math.max(1, map.landTileCount),
    coastShare: p.tiles > 0 ? coastCount(state, pid) / p.tiles : 0,
    neutral: 0,
    tribe: 0,
    nationTiles: 0,
    open: 0,
    nations: new Map(),
    bigId: 0,
    bigRatio: 0,
    enemyForts: 0,
    ports: countBuildings(state, pid, 'port'),
    markets: countBuildings(state, pid, 'market'),
    oil: depositCount(state, pid, 2),
    airfields: countBuildings(state, pid, 'airfield'),
    flight: hasTech(p, 'flight'),
    seaWar: 0,
    artilleryShare: 0,
  };
  const army = p.troops.infantry + p.troops.armor + p.troops.artillery;
  s.artilleryShare = army > 0 ? p.troops.artillery / army : 0;
  const { list, len } = borderTiles(state, pid);
  const step = Math.max(1, Math.ceil(len / MAX_BORDER_SAMPLES));
  for (let k = 0; k < len; k += step) {
    const n = nb4(list[k], w, owner.length);
    for (let q = 0; q < n; q++) {
      const j = NB[q];
      const t = terrain[j];
      const o = owner[j];
      if (t <= 1 || o === pid) continue;
      if (t === Terrain.Plains || t === Terrain.Desert) s.open++;
      if (o === 0) s.neutral++;
      else if (isTribe(state.players[o])) s.tribe++;
      else {
        s.nationTiles++;
        if (!areAllied(state, pid, o)) s.nations.set(o, (s.nations.get(o) ?? 0) + 1);
      }
    }
  }
  for (const q of s.nations.keys()) {
    const r = state.players[q].tiles / Math.max(1, p.tiles);
    if (r > s.bigRatio) {
      s.bigRatio = r;
      s.bigId = q;
    }
    for (const b of buildingsOf(state, q, 'fort')) if (b.buildLeft <= 0) s.enemyForts++;
  }
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (u.owner === pid) {
      if (u.type === 'transport' && u.targetOwner > 0 && !isTribe(state.players[u.targetOwner])) s.seaWar++;
      continue;
    }
    if (u.type !== 'warship' && u.type !== 'transport') continue;
    if (u.type === 'transport' && u.targetOwner !== pid) continue;
    if (u.type === 'warship' && (areAllied(state, pid, u.owner) || !atWarWith(state, pid, u.owner))) continue;
    s.seaWar++;
  }
  return s;
}
/** An attack runs between a and b (either way). */
function atWarWith(state: GameState, a: number, b: number): boolean {
  for (const at of state.attacks) {
    if ((at.attacker === a && at.target === b) || (at.attacker === b && at.target === a)) return true;
  }
  return false;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Every doctrine scored for pid's situation, best first (ties in DOCTRINE_IDS order). */
export function doctrineAdvice(state: GameState, pid: number): DoctrineAdvice[] {
  const p = state.players[pid];
  if (!nation(state, pid) || !p.alive || p.tiles <= 0) return [];
  const s = situation(state, pid);
  const m = mods(state);
  const foreign = Math.max(1, s.neutral + s.tribe + s.nationTiles);
  const openShare = s.open / foreign;
  const wildShare = (s.neutral + s.tribe) / foreign;
  const nations = s.nations.size;
  const big = s.bigId ? state.players[s.bigId] : null;
  const out: DoctrineAdvice[] = [];
  const add = (id: DoctrineId, score: number, reason: string): void => {
    out.push({ id, score: Math.max(0, score), reason });
  };

  add(
    'blitz',
    0.5 + 1.1 * openShare * Math.min(1, nations) + (s.oil > 0 ? 0.25 : 0),
    nations === 0
      ? 'No rival nation on your borders yet: blitz pays off once you have a front'
      : openShare >= 0.15
        ? `${pct(openShare)} of the land around you is plains or desert${s.oil > 0 ? ', and you have oil for armor' : ''}`
        : s.oil > 0
          ? 'You have oil for armor, though open ground is scarce around you'
          : 'Armored pushes, though open ground is scarce around you',
  );
  add(
    'fortress',
    0.45 + 0.2 * Math.min(nations, 3) + (s.bigRatio > 1.2 ? Math.min(0.9, (s.bigRatio - 1) * 0.6) : 0),
    big && s.bigRatio > 1.2
      ? `${big.name} borders you with ${s.bigRatio.toFixed(1)}x your land`
      : nations > 0
        ? `You border ${nations} rival nation${nations === 1 ? '' : 's'}`
        : 'Quiet borders: forts matter less for now',
  );
  add(
    'siege',
    0.45 + Math.min(1.1, s.enemyForts * 0.22) + (s.artilleryShare > 0.15 ? 0.2 : 0) + (nations > 0 ? 0.1 : 0),
    s.enemyForts > 0
      ? `${s.enemyForts} enemy fort${s.enemyForts === 1 ? '' : 's'} stand on your neighbours' land`
      : s.artilleryShare > 0.15
        ? `${pct(s.artilleryShare)} of your army is artillery`
        : 'No enemy forts yet: siege shines against fortified rivals',
  );
  add(
    'merchant',
    0.55 + Math.min(0.45, s.ports * 0.15) + Math.min(0.3, s.markets * 0.06) + (nations === 0 ? 0.25 : 0),
    s.ports + s.markets > 0
      ? `${s.ports} port${s.ports === 1 ? '' : 's'} and ${s.markets} market${s.markets === 1 ? '' : 's'} to make the most of`
      : 'Gold pays for everything: a safe choice for a growing economy',
  );
  const navalOff = m.noNavy ? 0.5 : 1;
  add(
    'naval',
    s.coastShare <= 0 ? 0.05 : (0.3 + Math.min(0.6, s.coastShare * 6) + Math.min(0.45, s.ports * 0.15) + Math.min(0.9, s.seaWar * 0.3)) * navalOff,
    s.coastShare <= 0
      ? 'You have no coast'
      : s.seaWar > 0
        ? 'A war at sea: enemy ships and landings are in play'
        : `${pct(s.coastShare)} of your land is coast`,
  );
  add(
    'air',
    m.noAir ? 0.05 : 0.3 + (s.flight ? 0.45 : 0) + Math.min(0.6, s.airfields * 0.3),
    m.noAir
      ? 'No air force in this game'
      : s.airfields > 0
        ? `${s.airfields} airfield${s.airfields === 1 ? '' : 's'} ready for bombers and paratroopers`
        : s.flight
          ? 'You have Flight: airfields are open to you'
          : 'Research Flight first to make use of it',
  );
  add(
    'expansion',
    0.35 + 1.2 * wildShare + (s.landShare < DOCTRINE_PERKS.expansion.smallShare[0] ? 0.3 : 0),
    wildShare > 0.05
      ? `${pct(wildShare)} of your border is tribes and wilderness`
      : s.landShare < DOCTRINE_PERKS.expansion.smallShare[0]
        ? 'Your nation is still small: troops grow faster'
        : 'Little free land left next to you',
  );
  // Stable order: best score first, then DOCTRINE_IDS order.
  out.sort((a, b) => b.score - a.score || DOCTRINE_IDS.indexOf(a.id) - DOCTRINE_IDS.indexOf(b.id));
  return out;
}

/** The 3 doctrines that fit pid's situation best, each with a plain reason. */
export function recommendDoctrines(state: GameState, pid: number): { id: DoctrineId; reason: string }[] {
  return doctrineAdvice(state, pid)
    .slice(0, 3)
    .map(({ id, reason }) => ({ id, reason }));
}
