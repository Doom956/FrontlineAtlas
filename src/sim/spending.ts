// Gold uses beyond buildings (owner request "more interesting ways to spend gold"):
//
// - Mercenaries (Action hireMercenaries): instant infantry. The price per troop rises with game time and with every
//   hire inside a MERC_WINDOW_SECONDS window (integrated over the amount, so one big hire costs the same as many
//   small ones); at most MERC_CAP_SHARE of the troop cap per window, home troops at most MERC_OVER_CAP over the cap.
// - Funding an ally (Action fundAlly): the gold goes to the ally, which then likes you more, needs less trust and
//   strength to join your wars, and attacks nations at war with you harder for FUND_SECONDS (GameState.allyFunds).
// - War bonds (Action warBonds): a short attack bonus for gold, with a cooldown.
//
// State: Player.spend (techtree.spendState) and GameState.allyFunds, both hashed. Deterministic: no randomness.
import {
  FUND_FULL_SECONDS,
  FUND_MAX_BONUS,
  FUND_MIN_GOLD,
  FUND_OPINION,
  FUND_OPINION_DISCOUNT,
  FUND_SECONDS,
  MERC_BASE_PRICE,
  MERC_CAP_SHARE,
  MERC_LAND_PRICE,
  MERC_MIN_AMOUNT,
  MERC_MIN_CAP,
  MERC_OVER_CAP,
  MERC_RISE,
  MERC_TIME_GROWTH,
  MERC_WINDOW_SECONDS,
  TICKS_PER_SECOND,
  WAR_BONDS_BONUS,
  WAR_BONDS_COOLDOWN,
  WAR_BONDS_INCOME_SECONDS,
  WAR_BONDS_MIN_GOLD,
  WAR_BONDS_SECONDS,
} from './config';
import { atWar, fmtTroops } from './allies';
import { areAllied, changeOpinion } from './diplomacy';
import { addEvent, gameSeconds } from './state';
import { spendState, techAllyOpinionDiscount, techAttackMul, techMercCostMul } from './techtree';
import { isTribe } from './types';
import type { ActionResult, AllyFunding, GameState, Player } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

function home(p: Player): number {
  return p.troops.infantry + p.troops.armor + p.troops.artillery;
}
function live(state: GameState, id: number): Player | null {
  const p = id > 0 ? state.players[id] : undefined;
  return p && p.alive && p.spawned ? p : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Mercenaries
// ---------------------------------------------------------------------------------------------------------------

export interface MercenaryQuote {
  /** gold for `amount` troops (Infinity when the amount is not allowed) */
  gold: number;
  /** average price per troop of this hire */
  perTroop: number;
  /** most troops that may be hired right now (window cap and cap margin; gold not counted) */
  max: number;
  /** most troops the player can afford right now (<= max) */
  affordable: number;
  /** why the amount can't be hired now, or null */
  reason: string | null;
}

/** Troops hired in the current window (0 once it ran out). */
function recentHires(state: GameState, p: Player): number {
  const s = p.spend;
  if (!s || state.tick - s.mercWindowTick >= MERC_WINDOW_SECONDS * TICKS_PER_SECOND) return 0;
  return s.mercRecent;
}
function mercCap(p: Player): number {
  return Math.max(1, p.maxPop);
}
/** Base price per troop now (before the in-window rise): time and Conscription. */
function mercBase(state: GameState, pid: number): number {
  const p = state.players[pid];
  const land = p ? p.tiles / Math.max(1, state.map.landTileCount) : 0;
  return MERC_BASE_PRICE * (1 + MERC_TIME_GROWTH * (gameSeconds(state) / 60)) * (1 + MERC_LAND_PRICE * land) * techMercCostMul(state, pid);
}
/** Gold for `a` troops when `r` were hired in this window already (the rising price integrated). */
function mercGold(base: number, r: number, a: number, cap: number): number {
  return base * (a + (MERC_RISE * (r * a + (a * a) / 2)) / cap);
}

/** Price and limits of hiring `amount` mercenaries (client: slider and live price; AI: planning). */
export function mercenaryPrice(state: GameState, pid: number, amount: number): MercenaryQuote {
  const p = live(state, pid);
  const none: MercenaryQuote = { gold: Infinity, perTroop: Infinity, max: 0, affordable: 0, reason: 'No such player' };
  if (!p) return none;
  if (isTribe(p)) return { ...none, reason: 'Tribes cannot hire mercenaries' };
  const cap = mercCap(p);
  const r = recentHires(state, p);
  const windowLeft = Math.max(0, Math.max(MERC_MIN_CAP, cap * MERC_CAP_SHARE) - r);
  const roomLeft = Math.max(0, cap * (1 + MERC_OVER_CAP) - home(p));
  const max = Math.floor(Math.min(windowLeft, roomLeft));
  const base = mercBase(state, pid);
  // Largest affordable amount: solve base x (a + RISE (r a + a^2/2) / cap) = gold for a (quadratic, a >= 0).
  const A = (base * MERC_RISE) / (2 * cap);
  const B = base * (1 + (MERC_RISE * r) / cap);
  const g = Math.max(0, p.gold);
  const byGold = A > 0 ? (-B + Math.sqrt(B * B + 4 * A * g)) / (2 * A) : g / B;
  const affordable = Math.max(0, Math.min(max, Math.floor(byGold)));
  const a = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const gold = mercGold(base, r, a, cap);
  let reason: string | null = null;
  if (!(a >= MERC_MIN_AMOUNT)) reason = `Hire at least ${fmtTroops(MERC_MIN_AMOUNT)} troops`;
  else if (max < MERC_MIN_AMOUNT) {
    reason = windowLeft < MERC_MIN_AMOUNT
      ? `No more mercenaries for hire this minute (wait ${Math.ceil(MERC_WINDOW_SECONDS - (state.tick - (p.spend?.mercWindowTick ?? 0)) / TICKS_PER_SECOND)} s)`
      : 'Your barracks are full: no room for mercenaries';
  } else if (a > max + 1e-6) reason = `At most ${fmtTroops(max)} mercenaries right now`;
  else if (gold > p.gold + 1e-6) reason = `Not enough gold (${Math.ceil(gold)})`;
  return { gold, perTroop: a > 0 ? gold / a : base, max, affordable, reason };
}

/** Action hireMercenaries: pay and add `amount` infantry at home now. */
export function hireMercenaries(state: GameState, pid: number, amount: number): ActionResult {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return FAIL('Invalid amount');
  const a = Math.floor(amount);
  const q = mercenaryPrice(state, pid, a);
  if (q.reason) return FAIL(q.reason);
  const p = state.players[pid];
  const s = spendState(p);
  if (state.tick - s.mercWindowTick >= MERC_WINDOW_SECONDS * TICKS_PER_SECOND) {
    s.mercWindowTick = state.tick;
    s.mercRecent = 0;
  }
  p.gold -= q.gold;
  p.troops.infantry += a;
  s.mercRecent += a;
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Funding allies
// ---------------------------------------------------------------------------------------------------------------

export interface FundAllyEffect {
  /** attack bonus (0.1 = +10%) against nations at war with you, for `seconds` (with what is still running) */
  bonus: number;
  seconds: number;
  /** opinion gained */
  opinion: number;
  /** how much less trust the ally needs to help you while funded */
  trustDiscount: number;
  /** why it can't be done, or null */
  reason: string | null;
}

function activeFunds(state: GameState): AllyFunding[] {
  return state.allyFunds ?? [];
}
function fundingOf(state: GameState, from: number, ally: number): AllyFunding | undefined {
  for (const f of activeFunds(state)) if (f.from === from && f.ally === ally && f.untilTick > state.tick) return f;
  return undefined;
}

/** What funding `ally` with `gold` would do (client preview; the action uses the same numbers). */
export function fundAllyEffect(state: GameState, pid: number, ally: number, gold: number): FundAllyEffect {
  const out: FundAllyEffect = { bonus: 0, seconds: FUND_SECONDS, opinion: 0, trustDiscount: 0, reason: null };
  const p = live(state, pid);
  const a = live(state, ally);
  if (!p) return { ...out, reason: 'No such player' };
  if (!a || ally === pid) return { ...out, reason: 'No such ally' };
  if (!areAllied(state, pid, ally)) return { ...out, reason: `${a.name} is not your ally` };
  if (isTribe(a)) return { ...out, reason: 'A tribe does not go to war: give it a gift instead' };
  const g = Number.isFinite(gold) ? Math.max(0, gold) : 0;
  const scale = Math.max(50, a.income.gold) * FUND_FULL_SECONDS;
  const fresh = FUND_MAX_BONUS * Math.min(1, g / scale);
  const running = fundingOf(state, pid, ally);
  out.bonus = Math.min(FUND_MAX_BONUS, fresh + (running ? running.bonus : 0));
  out.opinion = Math.round(FUND_OPINION * Math.min(1, g / scale) * 10) / 10;
  out.trustDiscount = (FUND_OPINION_DISCOUNT * out.bonus) / FUND_MAX_BONUS;
  if (!(g >= FUND_MIN_GOLD)) out.reason = `Send at least ${FUND_MIN_GOLD} gold`;
  else if (g > p.gold + 1e-6) out.reason = 'Not enough gold';
  return out;
}

/** Action fundAlly: gold to an ally, which then fights harder against your enemies for a while. */
export function fundAlly(state: GameState, pid: number, ally: number, gold: number): ActionResult {
  if (typeof gold !== 'number' || !Number.isFinite(gold)) return FAIL('Invalid amount');
  const e = fundAllyEffect(state, pid, ally, gold);
  if (e.reason) return FAIL(e.reason);
  const p = state.players[pid];
  const a = state.players[ally];
  p.gold -= gold;
  a.gold += gold;
  if (e.opinion > 0) changeOpinion(state, ally, pid, e.opinion);
  const funds = (state.allyFunds ??= []);
  const until = state.tick + FUND_SECONDS * TICKS_PER_SECOND;
  const running = funds.find((f) => f.from === pid && f.ally === ally);
  if (running) {
    running.bonus = e.bonus;
    running.untilTick = until;
  } else funds.push({ from: pid, ally, bonus: e.bonus, untilTick: until });
  const pct = Math.round(e.bonus * 100);
  if (p.isHuman) addEvent(state, 'allyAid', `You funded ${a.name} with ${fmtTroops(gold)} gold: +${pct}% attack against your enemies for ${FUND_SECONDS} s`, [pid], a.capital);
  if (a.isHuman) addEvent(state, 'allyAid', `${p.name} sent you ${fmtTroops(gold)} gold to fight its enemies`, [ally], p.capital);
  return { ok: true };
}

/** Attack bonus of `attacker` against `defender` from allies' funding (0 = none). */
export function fundingBonus(state: GameState, attacker: number, defender: number): number {
  const funds = state.allyFunds;
  if (!funds || !funds.length || defender <= 0) return 0;
  let best = 0;
  for (const f of funds) {
    if (f.ally !== attacker || f.untilTick <= state.tick || f.bonus <= best) continue;
    if (f.from === defender) continue;
    if (atWar(state, f.from, defender)) best = f.bonus;
  }
  return best;
}
/** How much less opinion `ally` needs of `from` to help it (Diplomatic Corps + running funding). */
export function allyTrustDiscount(state: GameState, ally: number, from: number): number {
  const f = fundingOf(state, from, ally);
  return techAllyOpinionDiscount(state, from) + (f ? (FUND_OPINION_DISCOUNT * f.bonus) / FUND_MAX_BONUS : 0);
}
/** Strength `ally` needs to join a war for `from`: x this (1 - running funding bonus). */
export function allyStrengthMul(state: GameState, ally: number, from: number): number {
  const f = fundingOf(state, from, ally);
  return f ? 1 - f.bonus : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// War bonds
// ---------------------------------------------------------------------------------------------------------------

export interface WarBondsInfo {
  price: number;
  bonus: number;
  seconds: number;
  /** seconds of the running bonus left (0 = none) */
  activeLeft: number;
  /** seconds until bonds can be bought again (0 = now) */
  readyIn: number;
  reason: string | null;
}

/** Price, bonus and cooldown of war bonds for pid. */
export function warBondsInfo(state: GameState, pid: number): WarBondsInfo {
  const p = live(state, pid);
  const out: WarBondsInfo = { price: Infinity, bonus: WAR_BONDS_BONUS, seconds: WAR_BONDS_SECONDS, activeLeft: 0, readyIn: 0, reason: 'No such player' };
  if (!p) return out;
  out.price = Math.round(Math.max(WAR_BONDS_MIN_GOLD, Math.max(0, p.income.gold) * WAR_BONDS_INCOME_SECONDS));
  const s = p.spend;
  out.activeLeft = s && s.bondsUntil > state.tick ? (s.bondsUntil - state.tick) / TICKS_PER_SECOND : 0;
  out.readyIn = s && s.bondsReadyTick > state.tick ? (s.bondsReadyTick - state.tick) / TICKS_PER_SECOND : 0;
  out.reason = null;
  if (isTribe(p)) out.reason = 'Tribes cannot sell war bonds';
  else if (out.readyIn > 0) out.reason = `War bonds can be sold again in ${Math.ceil(out.readyIn)} s`;
  else if (p.gold < out.price) out.reason = `Not enough gold (${out.price})`;
  return out;
}

/** Action warBonds: pay for WAR_BONDS_BONUS attack power during WAR_BONDS_SECONDS. */
export function buyWarBonds(state: GameState, pid: number): ActionResult {
  const i = warBondsInfo(state, pid);
  if (i.reason) return FAIL(i.reason);
  const p = state.players[pid];
  const s = spendState(p);
  p.gold -= i.price;
  s.bondsUntil = state.tick + WAR_BONDS_SECONDS * TICKS_PER_SECOND;
  s.bondsReadyTick = state.tick + WAR_BONDS_COOLDOWN * TICKS_PER_SECOND;
  if (p.isHuman) addEvent(state, 'info', `War bonds sold: +${Math.round(WAR_BONDS_BONUS * 100)}% attack for ${WAR_BONDS_SECONDS} s`, [pid], -1);
  return { ok: true };
}

/** True while pid's war bonds bonus runs. */
export function warBondsActive(state: GameState, pid: number): boolean {
  const s = state.players[pid]?.spend;
  return !!s && s.bondsUntil > state.tick;
}

// ---------------------------------------------------------------------------------------------------------------
// Combat hook and upkeep
// ---------------------------------------------------------------------------------------------------------------

/** Attack power x of attacker against defender: Mass Mobilization, war bonds, allies' funding (combat.ts fightCtx). */
export function attackBonusMul(state: GameState, attacker: number, defender: number): number {
  let m = techAttackMul(state, attacker);
  if (warBondsActive(state, attacker)) m *= 1 + WAR_BONDS_BONUS;
  if (state.allyFunds?.length) m *= 1 + fundingBonus(state, attacker, defender);
  return m;
}

/** Drops funding that ran out or whose sides are gone (once a second). */
export function updateSpending(state: GameState): void {
  const funds = state.allyFunds;
  if (!funds || !funds.length || state.tick % TICKS_PER_SECOND !== 0) return;
  const keep = funds.filter((f) => f.untilTick > state.tick && state.players[f.ally]?.alive && state.players[f.from]?.alive);
  if (keep.length !== funds.length) state.allyFunds = keep;
}
