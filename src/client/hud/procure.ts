// Arsenal purchases for the client (no DOM): every Arsenal item (arsenal.isArsenalTech) is bought with gold plus iron
// or oil and delivered after a short timer (sim/procurement.ts). This file turns the sim's answers into card states
// for hud/arsenalPage.ts, the orders strip of the panel header, the mastery counter and the guide.
import { MASTERY_CAP, PILLAR_NAMES, arsenalItem, isArsenalTech, masteryPillars, type Pillar } from '../../sim/arsenal';
import { BUILDINGS, TECHS, TICKS_PER_SECOND } from '../../sim/config';
import { countBuildings } from '../../sim/buildings';
import { arsenalPrice, canProcure, procurementOf } from '../../sim/procurement';
import { hasTech } from '../../sim/tech';
import { choiceLockedBy, rivalsOf, techStatus, techStatusReason } from '../../sim/techtree';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';

export interface Price {
  gold: number;
  iron: number;
  oil: number;
  seconds: number;
  needs?: BuildingType;
}
export interface Order {
  tech: TechId;
  readyTick: number;
  /** seconds until delivery, and the delivery time of the item (for the bar) */
  left: number;
  total: number;
  /** 0..1 of the wait done */
  frac: number;
}

export function priceOf(s: GameState, me: Player, t: TechId): Price {
  return arsenalPrice(s, me.id, t);
}

/** The player's orders in progress, soonest first. */
export function ordersOf(s: GameState, me: Player): Order[] {
  const out: Order[] = [];
  for (const o of procurementOf(s, me.id)) {
    const total = Math.max(1, priceOf(s, me, o.tech).seconds);
    const left = Math.max(0, (o.readyTick - s.tick) / TICKS_PER_SECOND);
    out.push({ tech: o.tech, readyTick: o.readyTick, left, total, frac: Math.max(0, Math.min(1, 1 - left / total)) });
  }
  return out.sort((a, b) => a.readyTick - b.readyTick);
}
export function orderOf(s: GameState, me: Player, t: TechId): Order | null {
  return ordersOf(s, me).find((o) => o.tech === t) ?? null;
}
/** On order (bought, not delivered yet). Reads Player.procuring directly: no state needed. */
export function onOrder(me: Player, t: TechId): boolean {
  return (me.procuring ?? []).some((o) => o.tech === t);
}
/** Owned, being researched or on order: the tech is "coming". */
export function techComing(me: Player, t: TechId): boolean {
  return hasTech(me, t) || me.researching === t || onOrder(me, t);
}

/** "Research Flight first" (Research tab) or "Buy Flight in the Arsenal first". */
export function techFirst(t: TechId): string {
  return isArsenalTech(t) ? `Buy ${TECHS[t].name} in the Arsenal first` : `Research ${TECHS[t].name} first`;
}
/** "research Rocketry" / "buy Navigation in the Arsenal" (lower case, for the middle of a sentence). */
export function techPhrase(t: TechId): string {
  return isArsenalTech(t) ? `buy ${TECHS[t].name} in the Arsenal` : `research ${TECHS[t].name}`;
}

/** "a Port", "an Airfield". */
export function aBuilding(b: BuildingType): string {
  const n = BUILDINGS[b].name;
  return `${/^[AEIOU]/.test(n) ? 'an' : 'a'} ${n}`;
}
/** The building t needs that the player has none of (finished), or null. */
export function missingBuilding(s: GameState, me: Player, t: TechId): BuildingType | null {
  const b = priceOf(s, me, t).needs;
  return b && countBuildings(s, me.id, b, false) === 0 ? b : null;
}

export type ArsenalCardState = 'done' | 'ordered' | 'buy' | 'poor' | 'building' | 'prereq' | 'chose-other' | 'capped' | 'disabled';
export interface ArsenalCard {
  state: ArsenalCardState;
  price: Price;
  /** which resources are short (the price shows them in red) */
  short: { gold: boolean; iron: boolean; oil: boolean };
  order: Order | null;
  /** the building it needs and the player lacks */
  building: BuildingType | null;
  /** the rival that locks it (chose-other) */
  chose: TechId | null;
  /** canProcure's refusal, or the lock reason */
  reason: string;
}

/** The rival choice (owned, researching or on order) that locks t, or null. */
export function lockedBy(me: Player, t: TechId): TechId | null {
  const by = choiceLockedBy(me, t);
  if (by) return by;
  for (const o of rivalsOf(t)) if (onOrder(me, o)) return o;
  for (const r of TECHS[t]?.requires ?? []) {
    const x = lockedBy(me, r);
    if (x) return x;
  }
  return null;
}

/** Pillars with a mastery owned, researching or on order. */
export function masteryUsed(me: Player): Pillar[] {
  const out = masteryPillars(me);
  for (const o of me.procuring ?? []) {
    const it = arsenalItem(o.tech);
    if (it?.kind === 'mastery' && !out.includes(it.pillar)) out.push(it.pillar);
  }
  return (['navy', 'armor', 'air'] as Pillar[]).filter((p) => out.includes(p));
}
/** "Cap used: Navy, Air" when mastery t is locked by the cap, else null. */
export function masteryCapped(me: Player, t: TechId): string | null {
  const it = arsenalItem(t);
  if (!it || it.kind !== 'mastery' || hasTech(me, t) || onOrder(me, t)) return null;
  const used = masteryUsed(me).filter((p) => p !== it.pillar);
  return used.length >= MASTERY_CAP ? `Cap used: ${used.map((p) => PILLAR_NAMES[p]).join(', ')}` : null;
}

/** Everything an Arsenal card shows. */
export function arsenalCard(s: GameState, me: Player, t: TechId): ArsenalCard {
  const price = priceOf(s, me, t);
  const short = { gold: me.gold < price.gold, iron: me.iron < price.iron, oil: me.oil < price.oil };
  const base = { price, short, order: null, building: null, chose: null, reason: '' };
  if (hasTech(me, t)) return { ...base, state: 'done', reason: `${TECHS[t].name} is in service` };
  const order = orderOf(s, me, t);
  if (order) return { ...base, state: 'ordered', order, reason: `On order: arrives in ${Math.ceil(order.left)} s` };
  const st = techStatus(s, me.id, t);
  if (st === 'disabled') return { ...base, state: 'disabled', reason: techStatusReason(s, me.id, t) ?? 'Not available' };
  const cap = masteryCapped(me, t);
  if (cap) return { ...base, state: 'capped', reason: cap };
  const chose = lockedBy(me, t);
  if (chose) return { ...base, state: 'chose-other', chose, reason: `You chose ${TECHS[chose].name}; ${TECHS[t].name} is locked` };
  const res = canProcure(s, me.id, t);
  if (st === 'locked-prereq') return { ...base, state: 'prereq', reason: techStatusReason(s, me.id, t) ?? res.reason ?? 'Needs another tech first' };
  const building = missingBuilding(s, me, t);
  if (building) return { ...base, state: 'building', building, reason: `Build ${aBuilding(building)} first` };
  if (res.ok) return { ...base, state: 'buy' };
  if (short.gold || short.iron || short.oil) return { ...base, state: 'poor', reason: res.reason ?? 'Not enough resources' };
  return { ...base, state: 'disabled', reason: res.reason ?? 'Not possible now' };
}

/** Any Arsenal item the player could buy now. */
export function canBuyAny(s: GameState, me: Player): boolean {
  for (const t of Object.keys(TECHS) as TechId[]) if (isArsenalTech(t) && canProcure(s, me.id, t).ok) return true;
  return false;
}

/**
 * How to get tech t, in order: "Research Logistics, then buy Flight in the Arsenal (T)", "Build a Port, then buy
 * Navigation in the Arsenal (T)", "Research Rocketry (T)". Missing research prerequisites first, then the building an
 * Arsenal item needs, then the item.
 */
export function howToGet(s: GameState, me: Player, t: TechId): string {
  const pre = TECHS[t].requires.filter((r) => !hasTech(me, r) && !isArsenalTech(r)).map((r) => TECHS[r].name);
  const steps: string[] = [];
  if (pre.length) steps.push(`research ${pre.join(' + ')}`);
  if (isArsenalTech(t)) {
    const b = missingBuilding(s, me, t);
    if (b) steps.push(`build ${aBuilding(b)}`);
    steps.push(`buy ${TECHS[t].name} in the Arsenal (T)`);
  } else steps.push(`research ${TECHS[t].name} (T)`);
  const txt = steps.join(', then ');
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}
