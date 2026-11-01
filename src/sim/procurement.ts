// Arsenal procurement: Arsenal items (arsenal.ts: pillar unlocks, path forks and their upgrades, specials, masteries,
// Mechanized Infantry, Recon Planes) are not researched with science. They are BOUGHT with gold plus the pillar's
// resource (armor: iron; navy and air: oil plus some iron) and DELIVERED after a short timer (Action 'procure').
//
// - Price by the item's Arsenal column (unlock, path, upgrade / special, mastery) x the pillar's resource mix: config
//   ARSENAL_PRICES. Paid in full when ordering; no refunds (an order can't be cancelled).
// - Several items can be on order at once (Player.procuring, in order of purchase; hashed).
// - The tech tree's rules stay: prerequisites must be delivered, ordering one side of a fork locks the other at once,
//   an order uses a mastery slot (MASTERY_CAP).
// - Each pillar's items need a finished building of its own: navy a Port, armor a Factory, air an Airfield; an item
//   that unlocks that building itself (Flight unlocks the Airfield) needs none, so nothing is circular.
// - Delivery (updateProcurement, every tick): the tech is pushed to Player.techs, exactly as a finished research was,
//   with a 'researchDone' event "Delivered: <name>".
// Deterministic: state only.
import { ARSENAL_PRICES, BUILDINGS, TECHS, TICKS_PER_SECOND } from './config';
import { addEvent } from './state';
import { countBuildings } from './buildings';
import { arsenalItem, isArsenalTech, masteryLocked, onOrder } from './arsenal';
import { choiceLockReason, missingPrereqs, prereqsMet, techStatus, techStatusReason } from './techtree';
import { researchRule } from './rules';
import type { ActionResult, BuildingType, GameState, TechId } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

export interface ArsenalPrice {
  gold: number;
  iron: number;
  oil: number;
  /** delivery time after ordering */
  seconds: number;
  /** a finished own building of this type is needed to order (absent = none) */
  needs?: BuildingType;
}

type ArmPillar = 'armor' | 'navy' | 'air';

/** The pillar whose resource mix and building an item uses (shared items: ARSENAL_PRICES.shared). */
function armPillarOf(t: TechId): ArmPillar | null {
  const it = arsenalItem(t);
  if (!it) return null;
  if (it.pillar !== 'shared') return it.pillar;
  return ARSENAL_PRICES.shared[t] ?? null;
}

/** True if tech `t` is, or leads to, the tech that unlocks building b (ordering t can't need b: circular). */
function unlocksBuilding(t: TechId, b: BuildingType): boolean {
  const bt = BUILDINGS[b].tech;
  if (!bt) return false;
  const seen = new Set<TechId>();
  const walk = (x: TechId): boolean => {
    if (x === t) return true;
    if (seen.has(x)) return false;
    seen.add(x);
    const info = TECHS[x];
    return info.requires.some(walk) || (info.requiresAny ?? []).some(walk);
  };
  return walk(bt);
}

/** The building an Arsenal item needs (undefined = none). Never one that the item itself (or its chain) unlocks. */
export function buildingNeedOf(t: TechId): BuildingType | undefined {
  const pillar = armPillarOf(t);
  if (!pillar || ARSENAL_PRICES.sharedNoBuilding.includes(t)) return undefined;
  const b = ARSENAL_PRICES.building[pillar];
  return unlocksBuilding(t, b) ? undefined : b;
}

/** Price of an Arsenal item (the same for everyone; pid / state kept for later modifiers). Zero for other techs. */
export function arsenalPrice(state: GameState, pid: number, t: TechId): ArsenalPrice {
  void state;
  void pid;
  const it = arsenalItem(t);
  const pillar = armPillarOf(t);
  if (!it || !pillar) return { gold: 0, iron: 0, oil: 0, seconds: 0 };
  const tier = ARSENAL_PRICES.tiers[it.tier] ?? ARSENAL_PRICES.tiers[3];
  const mix = ARSENAL_PRICES.mix[pillar];
  const out: ArsenalPrice = {
    gold: tier.gold,
    iron: Math.round(tier.resource * mix.iron),
    oil: Math.round(tier.resource * mix.oil),
    seconds: tier.seconds,
  };
  const needs = buildingNeedOf(t);
  if (needs) out.needs = needs;
  return out;
}

/**
 * Whether pid may order t now; reason when not ("Needs a Port", "Not enough oil (420)", "You chose Destroyers;
 * Submarines is locked", "Mastery 2 of 2 used (...)", "Destroyers is on order").
 */
export function canProcure(state: GameState, pid: number, t: TechId): { ok: boolean; reason?: string } {
  return check(state, pid, t, true);
}
/** canProcure without the price check (AI: is this item worth saving up for?). */
export function canProcureIgnoringCost(state: GameState, pid: number, t: TechId): { ok: boolean; reason?: string } {
  return check(state, pid, t, false);
}
function check(state: GameState, pid: number, t: TechId, cost: boolean): { ok: boolean; reason?: string } {
  const p = pid > 0 ? state.players[pid] : undefined;
  if (!p || !p.alive) return FAIL('No such player');
  const info = TECHS[t];
  if (!info) return FAIL('Unknown tech');
  if (!isArsenalTech(t)) return FAIL(`${info.name} is researched in the Research tab, not bought`);
  const ruled = researchRule(state);
  if (ruled) return FAIL(ruled);
  if (p.techs.includes(t)) return FAIL(`${info.name} is already yours`);
  if (onOrder(p, t)) return FAIL(`${info.name} is already on order`);
  const locked = choiceLockReason(p, t);
  if (locked) return FAIL(locked);
  const capped = masteryLocked(p, t);
  if (capped) return FAIL(capped);
  if (techStatus(state, pid, t) === 'disabled') return FAIL(techStatusReason(state, pid, t) ?? 'Not available in this game');
  if (!prereqsMet(p, t)) return FAIL(`Needs ${missingPrereqs(p, t)}`);
  const price = arsenalPrice(state, pid, t);
  if (price.needs && countBuildings(state, pid, price.needs) <= 0) {
    const name = BUILDINGS[price.needs].name;
    return FAIL(`Needs ${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`);
  }
  if (!cost) return { ok: true };
  if (p.gold < price.gold) return FAIL(`Not enough gold (${price.gold})`);
  if (p.iron < price.iron) return FAIL(`Not enough iron (${price.iron})`);
  if (p.oil < price.oil) return FAIL(`Not enough oil (${price.oil})`);
  return { ok: true };
}

/** Pays and puts t on order (delivered after its timer). */
export function procure(state: GameState, pid: number, t: TechId): ActionResult {
  const ok = canProcure(state, pid, t);
  if (!ok.ok) return { ok: false, reason: ok.reason };
  const p = state.players[pid];
  const price = arsenalPrice(state, pid, t);
  p.gold -= price.gold;
  p.iron -= price.iron;
  p.oil -= price.oil;
  (p.procuring ??= []).push({ tech: t, readyTick: state.tick + Math.max(1, Math.round(price.seconds * TICKS_PER_SECOND)) });
  return { ok: true };
}

/** Items p has on order, in order of purchase (a copy). */
export function procurementOf(state: GameState, pid: number): { tech: TechId; readyTick: number }[] {
  const p = pid > 0 ? state.players[pid] : undefined;
  return p?.procuring ? p.procuring.map((o) => ({ tech: o.tech, readyTick: o.readyTick })) : [];
}

/** Delivers every order whose timer ran out (in order of purchase); drops orders of techs already owned (a grant). */
export function updateProcurement(state: GameState): void {
  for (const p of state.players) {
    const list = p.procuring;
    if (!list || !list.length) continue;
    if (p.id === 0 || !p.alive) {
      p.procuring = [];
      continue;
    }
    let keep = 0;
    for (let k = 0; k < list.length; k++) {
      const o = list[k];
      if (p.techs.includes(o.tech)) continue; // granted meanwhile (admin console, tutorial)
      if (o.readyTick > state.tick) {
        list[keep++] = o;
        continue;
      }
      p.techs.push(o.tech);
      addEvent(state, 'researchDone', `Delivered: ${TECHS[o.tech].name}`, [p.id], -1);
    }
    list.length = keep;
  }
}

/** Delivers all of p's orders at once (admin console 'finishResearch'); the number delivered. */
export function deliverAllOrders(state: GameState, pid: number): number {
  const p = state.players[pid];
  if (!p?.procuring?.length) return 0;
  let n = 0;
  for (const o of p.procuring) {
    if (p.techs.includes(o.tech)) continue;
    p.techs.push(o.tech);
    n++;
    addEvent(state, 'researchDone', `Delivered: ${TECHS[o.tech].name}`, [p.id], -1);
  }
  p.procuring = [];
  return n;
}
