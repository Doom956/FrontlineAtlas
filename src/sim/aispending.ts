// AI use of the branch techs, gold uses and bulk orders (ai.ts calls in here; everything goes through applyAction).
//
// - Research: aiTechOrder merges a nation's profile order with the branch techs, each branch placed right after its
//   prerequisites; for every exclusive group the nation commits to ONE member, picked from a personality lean and a
//   per-game hash of its id (so both options get played and batch.ts can compare their win rates).
// - Gold: mercenaries when a war goes badly or a big attack needs troops, funding an ally that fights a common enemy,
//   war bonds before a strong push, bulk city upgrades and area upgrades when gold piles up.
// Decisions are deterministic (hashes and state only). Timers live in a per-game WeakMap like ai.ts's memory.
import { applyAction } from './actions';
import { atWar } from './allies';
import { buildingCost, buildingMaxLevel, buildingsOf } from './buildings';
import { TECH_ORDER, TECHS, TICKS_PER_SECOND } from './config';
import { effectiveLevel } from './bulkbuild';
import { fundAllyEffect, mercenaryPrice, warBondsInfo } from './spending';
import { rivalsOf, techStatus } from './techtree';
import { isTribe } from './types';
import type { Attack, GameState, Personality, TechId } from './types';

/** Lean toward the FIRST member of each group by personality (0..1; missing = 0.5). */
const BRANCH_LEAN: Record<string, Partial<Record<Personality, number>>> = {
  finance: { merchant: 0.25, turtle: 0.7, balanced: 0.5, admiral: 0.4, warlord: 0.55 }, // stockExchange | freeTrade
  landDoctrine: { warlord: 0.75, turtle: 0.2, balanced: 0.5, admiral: 0.5, merchant: 0.45 }, // blitzTactics | trenchWarfare
  navalDoctrine: { admiral: 0.45, warlord: 0.4, balanced: 0.5, turtle: 0.6, merchant: 0.6 }, // carriers | submarines
  airDoctrine: { warlord: 0.45, turtle: 0.6, balanced: 0.5, admiral: 0.5, merchant: 0.55 }, // jetEngines | strategicBombing
  statecraft: { merchant: 0.75, warlord: 0.3, turtle: 0.5, balanced: 0.5, admiral: 0.55 }, // diplomaticCorps | conscription
  capstone: { warlord: 0.75, turtle: 0.35, merchant: 0.3, balanced: 0.5, admiral: 0.5 }, // massMobilization | automation
};
/** An AI researches this many techs of its profile order before any branch tech. */
const AI_BRANCHES_AFTER = 10;
/** Branch techs in the order an AI weighs them (exclusive pairs: only the picked member is used). */
const BRANCH_TECHS: TechId[] = TECH_ORDER.filter((t) => !!TECHS[t].exclusiveGroup || !!TECHS[t].requiresAny || ['propaganda', 'railways'].includes(t));

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x6b43a9b5, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
function groupSalt(g: string): number {
  let h = 7;
  for (let k = 0; k < g.length; k++) h = Math.imul(h, 31) + g.charCodeAt(k);
  return h;
}

/** The member of `group` AI `id` commits to (stable for the game). */
export function aiBranchPick(state: GameState, id: number, personality: Personality | null, group: string): TechId {
  const members = TECH_ORDER.filter((t) => TECHS[t].exclusiveGroup === group);
  const p = state.players[id];
  // Already chosen (or researching one): stick to it.
  for (const t of members) if (p && (p.techs.includes(t) || p.researching === t)) return t;
  const lean = BRANCH_LEAN[group]?.[personality ?? 'balanced'] ?? 0.5;
  const u = mix(state.settings.seed * 131 + id, groupSalt(group));
  return u < lean ? members[0] : members[members.length - 1];
}

/** True for techs an AI never wants: the rival of its pick in an exclusive group. */
export function rejectedBranch(state: GameState, id: number, personality: Personality | null, t: TechId): boolean {
  const g = TECHS[t].exclusiveGroup;
  return !!g && aiBranchPick(state, id, personality, g) !== t;
}

/**
 * Research order of an AI: its profile order, each branch tech inserted right after the techs it needs (rivals of
 * its picks left out), the rest of the branch techs at the end.
 */
export function aiTechOrder(state: GameState, id: number, personality: Personality | null, profile: readonly TechId[]): TechId[] {
  const out: TechId[] = [];
  const have = new Set<TechId>();
  const pending = BRANCH_TECHS.filter((t) => !rejectedBranch(state, id, personality, t));
  // Next branch tech whose requirements are already in the order (null = none ready).
  const ready = (): TechId | null => {
    for (const t of pending) {
      const info = TECHS[t];
      if (info.requires.every((r) => have.has(r)) && (!info.requiresAny || info.requiresAny.some((r) => have.has(r)))) return t;
    }
    return null;
  };
  const take = (t: TechId): void => {
    out.push(t);
    have.add(t);
    pending.splice(pending.indexOf(t), 1);
  };
  // Branches only once the core of the profile is done (the base tree paces the game: armor, artillery, flight,
  // atom bombs), then one branch tech after each further profile tech, the rest at the end.
  let k = 0;
  for (const t of profile) {
    if (have.has(t)) continue;
    out.push(t);
    have.add(t);
    if (++k >= AI_BRANCHES_AFTER) {
      const b = ready();
      if (b) take(b);
    }
  }
  for (let b = ready(); b; b = ready()) take(b);
  for (const t of pending) out.push(t);
  return out;
}

/** First available techs of an AI's order (techStatus 'available'), at most `n`. */
export function aiAvailableTechs(state: GameState, id: number, order: readonly TechId[], n: number): TechId[] {
  const out: TechId[] = [];
  for (const t of order) {
    if (techStatus(state, id, t) !== 'available') continue;
    if (rivalsOf(t).length && rejectedBranch(state, id, state.players[id]?.personality ?? null, t)) continue;
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Gold uses
// ---------------------------------------------------------------------------------------------------------------

/** What ai.ts knows at a decision (a subset of its Ctx). */
export interface AISpendView {
  id: number;
  personality: Personality | null;
  /** troops at home, troop cap */
  home: number;
  cap: number;
  incomingTotal: number;
  allies: number[];
  myAttacks: Attack[];
  /** biggest danger ratio among neighbours (ai.ts Ctx.threat) */
  threat: number;
  /** AI difficulty is careful (normal and up) */
  careful: boolean;
}

interface Timers {
  merc: number;
  fund: number;
  bonds: number;
  bulk: number;
}
/** Counters for balance runs (scripts/batch.ts reads them with aiSpendStats). */
export interface AISpendStats {
  mercHires: number;
  mercTroops: number;
  fundings: number;
  fundGold: number;
  bonds: number;
  bulkOrders: number;
  areaOrders: number;
}
const timers = new WeakMap<GameState, Map<number, Timers>>();
const statsOf = new WeakMap<GameState, AISpendStats>();
export function aiSpendStats(state: GameState): AISpendStats {
  let s = statsOf.get(state);
  if (!s) statsOf.set(state, (s = { mercHires: 0, mercTroops: 0, fundings: 0, fundGold: 0, bonds: 0, bulkOrders: 0, areaOrders: 0 }));
  return s;
}
function timersOf(state: GameState, id: number): Timers {
  let m = timers.get(state);
  if (!m) timers.set(state, (m = new Map()));
  let t = m.get(id);
  if (!t) m.set(id, (t = { merc: 0, fund: 0, bonds: 0, bulk: 0 }));
  return t;
}
const S = TICKS_PER_SECOND;
function sum(t: { infantry: number; armor: number; artillery: number }): number {
  return t.infantry + t.armor + t.artillery;
}

/** One spending pass of an AI nation (after its economy step). At most one gold use per call. */
export function aiSpend(state: GameState, v: AISpendView): void {
  const p = state.players[v.id];
  if (!p || !p.alive || isTribe(p)) return;
  const t = timersOf(state, v.id);
  const now = state.tick;
  const income = Math.max(1, p.income.gold);
  const stats = aiSpendStats(state);
  const warlike = v.personality === 'warlord' ? 1.3 : v.personality === 'merchant' || v.personality === 'turtle' ? 0.8 : 1;

  // 1. Mercenaries: losing at home, or a big attack running while the bar is low.
  const losing = v.incomingTotal > v.home * 0.6 && v.incomingTotal > 20000;
  const pushing = v.myAttacks.some((a) => a.target > 0 && !isTribe(state.players[a.target]) && sum(a.troops) > v.home);
  if (now >= t.merc && (losing || (pushing && v.home < v.cap * 0.35)) && p.gold > income * 20) {
    const budget = p.gold * (losing ? 0.5 : 0.3) * warlike;
    const q0 = mercenaryPrice(state, v.id, 1000);
    let amount = Math.floor(Math.min(q0.affordable, budget / Math.max(1e-6, q0.perTroop)));
    // The price rises within the hire: shrink until it fits the budget.
    for (let k = 0; k < 6 && amount >= 1000 && mercenaryPrice(state, v.id, amount).gold > budget; k++) amount = Math.floor(amount * 0.7);
    if (amount >= 1000 && applyAction(state, v.id, { type: 'hireMercenaries', amount }).ok) {
      stats.mercHires++;
      stats.mercTroops += amount;
      t.merc = now + 30 * S;
      return;
    }
    t.merc = now + 10 * S;
  }

  // 2. War bonds before / during a strong push against a nation.
  if (now >= t.bonds && pushing) {
    const b = warBondsInfo(state, v.id);
    if (!b.reason && p.gold > b.price * (1.3 / warlike) && applyAction(state, v.id, { type: 'warBonds' }).ok) {
      stats.bonds++;
      t.bonds = now + 60 * S;
      return;
    }
    t.bonds = now + 15 * S;
  }

  // 3. Fund an ally that fights someone we fight (or who attacks us), when gold piles up.
  if (now >= t.fund && v.allies.length && p.gold > income * (v.personality === 'merchant' ? 20 : 35)) {
    t.fund = now + 20 * S;
    let best = 0;
    for (const a of v.allies) {
      const ap = state.players[a];
      if (!ap?.alive || isTribe(ap)) continue;
      for (const at of state.attacks) {
        const foe = at.attacker === a ? at.target : at.target === a ? at.attacker : 0;
        if (foe <= 0 || foe === v.id || isTribe(state.players[foe])) continue;
        if (atWar(state, v.id, foe)) {
          best = a;
          break;
        }
      }
      if (best) break;
    }
    if (best) {
      const gold = Math.floor(Math.min(p.gold * 0.25, Math.max(500, state.players[best].income.gold * 60)));
      if (!fundAllyEffect(state, v.id, best, gold).reason && applyAction(state, v.id, { type: 'fundAlly', ally: best, gold }).ok) {
        stats.fundings++;
        stats.fundGold += gold;
        t.fund = now + 90 * S;
        return;
      }
    }
  }

  // 4. Bulk orders when gold piles up: a city straight up several levels, else an area upgrade around the capital.
  if (now >= t.bulk) {
    t.bulk = now + 25 * S;
    const city = buildingCost(state, v.id, 'city').gold;
    if (p.gold > city * 4) {
      let target = -1;
      let low = Infinity;
      for (const b of buildingsOf(state, v.id, 'city')) {
        const eff = effectiveLevel(b);
        if (b.buildLeft > 0 || eff > buildingMaxLevel('city') - 2) continue;
        if (eff < low || (eff === low && b.id < (target >= 0 ? state.map.building[target] - 1 : Infinity))) {
          low = eff;
          target = b.tile;
        }
      }
      if (target >= 0 && applyAction(state, v.id, { type: 'buildMany', building: 'city', tile: target, count: 3 }).ok) {
        stats.bulkOrders++;
        return;
      }
    }
    if (p.capital >= 0 && p.gold > city * 8 && applyAction(state, v.id, { type: 'upgradeArea', tile: p.capital, radius: 40, levels: 1 }).ok) {
      stats.areaOrders++;
    }
  }
}
