// Tech tree branches with exclusive choices (DESIGN: "more ways to play").
//
// TECHS (config) gained branch techs. A tech with TechInfo.exclusiveGroup belongs to a choice: researching (or
// starting) one tech of the group locks the others for the rest of the game (techStatus 'locked-choice';
// canResearch refuses with "You chose Free Trade; Stock Exchange is locked"). Switching the running research away
// from a choice before it is done frees the group again (nothing was chosen yet). TechInfo.requiresAny: a tech after
// a fork needs at least one of its branches.
//
// The effects live here as small helpers that the sim systems call (economy, combat, buildings, units, allies), so
// every number stays in config TECH_EFFECTS. Everything is a pure function of the state: deterministic.
import { TECH_EFFECTS as E, TECH_GROUP_NAMES, TECH_ORDER, TECHS, TICKS_PER_SECOND } from './config';
import { areAllied } from './diplomacy';
import { atPeace, mods, researchRule } from './rules';
import { addEvent } from './state';
import { earlyWarningSees, nightDodges } from './specials';
import { arsenalItem, isArsenalTech, masteryLocked, onOrder } from './arsenal';
import { subRevealedTo } from './variants';
import type { BuildingType, GameState, Player, SpendState, TechId, Unit } from './types';

/** 'researching' also means "on order" for an Arsenal item (procurement.ts: bought, waiting for delivery). */
export type TechStatus = 'done' | 'researching' | 'available' | 'locked-prereq' | 'locked-choice' | 'disabled';

function owns(p: Player | undefined, t: TechId): boolean {
  return !!p && p.techs.includes(t);
}
/** Player by id if it is a real one (not the neutral slot). */
function pl(state: GameState, id: number): Player | undefined {
  return id > 0 ? state.players[id] : undefined;
}
/** True if player `id` has tech t (safe for 0 / unknown ids). */
export function techOf(state: GameState, id: number, t: TechId): boolean {
  return owns(pl(state, id), t);
}

/** Techs of an exclusive group, in TECH_ORDER. */
export function groupMembers(group: string): TechId[] {
  return TECH_ORDER.filter((t) => TECHS[t].exclusiveGroup === group);
}
/** Every exclusive group id, in TECH_ORDER of its first tech. */
export function exclusiveGroups(): string[] {
  const out: string[] = [];
  for (const t of TECH_ORDER) {
    const g = TECHS[t].exclusiveGroup;
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}
/** Display name of a group ("Finance"). */
export function groupName(group: string): string {
  return TECH_GROUP_NAMES[group] ?? group;
}
/** The other techs of t's choice group (empty for an ordinary tech). */
export function rivalsOf(t: TechId): TechId[] {
  const g = TECHS[t]?.exclusiveGroup;
  return g ? groupMembers(g).filter((o) => o !== t) : [];
}
/** Requirements met: every `requires` and at least one of `requiresAny` (when given). */
export function prereqsMet(p: Player, t: TechId): boolean {
  const info = TECHS[t];
  if (!info) return false;
  if (!info.requires.every((r) => owns(p, r))) return false;
  return !info.requiresAny || info.requiresAny.length === 0 || info.requiresAny.some((r) => owns(p, r));
}
/** Names of what is missing ("Banking and Stock Exchange or Free Trade"), '' when nothing. */
export function missingPrereqs(p: Player, t: TechId): string {
  const info = TECHS[t];
  const parts = info.requires.filter((r) => !owns(p, r)).map((r) => TECHS[r].name);
  if (info.requiresAny?.length && !info.requiresAny.some((r) => owns(p, r))) parts.push(info.requiresAny.map((r) => TECHS[r].name).join(' or '));
  return parts.join(' and ');
}
/**
 * The rival tech that locks t for p (researched, or being researched), or null. A tech after a locked one (Battleships
 * after Destroyers once Submarines is chosen: arsenal.ts forks) is locked by the same choice.
 */
export function choiceLockedBy(p: Player, t: TechId): TechId | null {
  for (const o of rivalsOf(t)) if (owns(p, o) || p.researching === o || onOrder(p, o)) return o; // an order locks at once (procurement.ts)
  for (const r of TECHS[t]?.requires ?? []) {
    const by = choiceLockedBy(p, r);
    if (by) return by;
  }
  return null;
}
/** "You chose Free Trade; Stock Exchange is locked", or null when t is not locked by a choice. */
export function choiceLockReason(p: Player, t: TechId): string | null {
  const by = choiceLockedBy(p, t);
  return by ? `You chose ${TECHS[by].name}; ${TECHS[t].name} is locked` : null;
}
/** Tooltip warning before choosing: "Choosing this locks Stock Exchange" (null for an ordinary tech). */
export function choiceWarning(t: TechId): string | null {
  const r = rivalsOf(t);
  return r.length ? `Choosing this locks ${r.map((o) => TECHS[o].name).join(' and ')}` : null;
}
/** Why a whole tech is off in this game (research off, or its weapons are), or null. */
function disabledReason(state: GameState, t: TechId): string | null {
  const m = mods(state);
  if (m.research === 'off') return 'Research is off in this game';
  if ((t === 'carriers' || t === 'submarines') && m.noNavy) return 'Warships are off in this game';
  if ((t === 'jetEngines' || t === 'strategicBombing') && m.noAir) return 'Aircraft are off in this game';
  if ((t === 'dropTanks' || t === 'nightBombing') && m.noAir) return 'Aircraft are off in this game'; // specials.ts
  // Arsenal variants and masteries (arsenal.ts) of a pillar whose weapons are off.
  const it = arsenalItem(t);
  if (it && (it.kind === 'variant' || it.kind === 'mastery')) {
    if (it.pillar === 'navy' && m.noNavy) return 'Warships are off in this game';
    if (it.pillar === 'air' && m.noAir) return 'Aircraft are off in this game';
  }
  if (t === 'reconPlanes' && m.noAir) return 'Aircraft are off in this game';
  return null;
}

/** Where a tech stands for a player (the tech tree UI and the AI read this). */
export function techStatus(state: GameState, pid: number, t: TechId): TechStatus {
  const p = pl(state, pid);
  if (!p || !TECHS[t]) return 'disabled';
  if (owns(p, t)) return 'done';
  if (p.researching === t || onOrder(p, t)) return 'researching'; // Arsenal: on order
  if (disabledReason(state, t) || researchRule(state)) return 'disabled';
  if (choiceLockedBy(p, t) || masteryLocked(p, t)) return 'locked-choice'; // forks; mastery cap (arsenal.ts)
  if (!prereqsMet(p, t)) return 'locked-prereq';
  return 'available';
}
/** One-line reason for a status that is not 'available' (UI), or null. */
export function techStatusReason(state: GameState, pid: number, t: TechId): string | null {
  const p = pl(state, pid);
  if (!p || !TECHS[t]) return 'Unknown tech';
  switch (techStatus(state, pid, t)) {
    case 'done':
      return `${TECHS[t].name} is already researched`;
    case 'researching':
      return isArsenalTech(t) ? `${TECHS[t].name} is on order` : `Already researching ${TECHS[t].name}`;
    case 'disabled':
      return disabledReason(state, t) ?? researchRule(state) ?? 'Not available';
    case 'locked-choice':
      return choiceLockReason(p, t) ?? masteryLocked(p, t);
    case 'locked-prereq':
      return `Needs ${missingPrereqs(p, t)}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Effects (multipliers; 1 = no effect). Callers: economy.ts, combat.ts, buildings.ts, units.ts, allies.ts.
// ---------------------------------------------------------------------------------------------------------------

/** Troop cap x (Conscription, Mass Mobilization). */
export function techCapMul(p: Player): number {
  return (owns(p, 'conscription') ? E.conscriptionCap : 1) * (owns(p, 'massMobilization') ? E.mobilizationCap : 1);
}
/** Troop growth x (Conscription). */
export function techGrowthMul(p: Player): number {
  return owns(p, 'conscription') ? E.conscriptionGrowth : 1;
}
/** Gold, iron and oil income x (Industrial Boom). */
export function techIncomeMul(p: Player): number {
  return owns(p, 'industrialBoom') ? E.industrialBoomIncome : 1;
}
/**
 * Stock Exchange interest per second: stockInterestPerS of the gold reserve, the reserve counting at most
 * stockInterestCapSeconds of gold income (so at most +stockInterestPerS x cap of the income).
 */
export function stockInterest(p: Player, goldIncome: number): number {
  if (!owns(p, 'stockExchange') || !(goldIncome > 0) || !(p.gold > 0)) return 0;
  return Math.min(p.gold, goldIncome * E.stockInterestCapSeconds) * E.stockInterestPerS;
}
/** Attack power x of attacker's troops against defender (Mass Mobilization). */
export function techAttackMul(state: GameState, attacker: number): number {
  return techOf(state, attacker, 'massMobilization') ? E.mobilizationAttack : 1;
}
/** Attacker losses x when attacker hits defender's land (Trench Warfare, Propaganda of the defender). */
export function techLossMul(state: GameState, attacker: number, defender: number): number {
  void attacker;
  const d = pl(state, defender);
  if (!d) return 1;
  return (owns(d, 'trenchWarfare') ? E.trenchDefense : 1) * (owns(d, 'propaganda') ? E.propagandaAttackerLoss : 1);
}
/** Front speed x (Railways, Blitz Tactics by armor share; the defender's Trench Warfare slows it). */
export function techFrontSpeedMul(state: GameState, attacker: number, defender: number, armorShare: number): number {
  const a = pl(state, attacker);
  let m = 1;
  if (a) {
    if (owns(a, 'railways')) m *= E.railwaysFrontSpeed;
    if (owns(a, 'blitzTactics')) m *= 1 + E.blitzArmorSpeed * Math.max(0, Math.min(1, armorShare));
  }
  if (techOf(state, defender, 'trenchWarfare')) m *= E.trenchEnemySpeed;
  return m;
}
/** Supply range x (Railways). */
export function techSupplyRangeMul(p: Player): number {
  return owns(p, 'railways') ? E.railwaysSupplyRange : 1;
}
/** Building price x (Free Trade: markets, Trench Warfare: forts, Automation: all). */
export function techBuildingCostMul(state: GameState, pid: number, type: BuildingType): number {
  const p = pl(state, pid);
  if (!p) return 1;
  let m = owns(p, 'automation') ? E.automationCost : 1;
  if (type === 'market' && owns(p, 'freeTrade')) m *= E.freeTradeMarketCost;
  if (type === 'fort' && owns(p, 'trenchWarfare')) m *= E.trenchFortCost;
  return m;
}
/** Construction / upgrade time x (Automation). */
export function techBuildTimeMul(state: GameState, pid: number): number {
  return techOf(state, pid, 'automation') ? E.automationBuildTime : 1;
}
/** Trade ship gold to this player x (Free Trade). */
export function techTradeGoldMul(state: GameState, pid: number): number {
  return techOf(state, pid, 'freeTrade') ? E.freeTradeGold : 1;
}
/**
 * Warship damage against ships x. Submarines no longer boost every warship: the submarine variant hits trade ships and
 * transports harder itself (variants.ts navalDamageMul via naval2.shipDamageMul). Kept for callers: always 1.
 */
export function techShipDamageMul(state: GameState, pid: number): number {
  void state;
  void pid;
  return 1;
}
/** Bomber / cargo plane speed x (Jet Engines). */
export function techAirSpeedMul(state: GameState, pid: number): number {
  return techOf(state, pid, 'jetEngines') ? E.jetSpeed : 1;
}
/** Extra hit points of a new bomber (Jet Engines). */
export function techBomberExtraHp(state: GameState, pid: number): number {
  return techOf(state, pid, 'jetEngines') ? E.jetExtraHp : 0;
}
/** Bomb radius x (Strategic Bombing). */
export function techBombRadiusMul(state: GameState, pid: number): number {
  return techOf(state, pid, 'strategicBombing') ? E.strategicRadius : 1;
}
/** Chance per building in the bomb radius to be wrecked (Strategic Bombing raises it). */
export function techBombBuildingHit(state: GameState, pid: number, base: number): number {
  return techOf(state, pid, 'strategicBombing') ? Math.max(base, E.strategicBuildingHit) : base;
}
/**
 * Strategic Bombing: a raid by `attacker` burns a share of each victim's gold and iron stock. Returns the gold burnt
 * (for the event text).
 */
export function strategicBurn(state: GameState, attacker: number, victims: Iterable<number>): number {
  if (!techOf(state, attacker, 'strategicBombing')) return 0;
  let gold = 0;
  for (const v of victims) {
    const p = pl(state, v);
    if (!p || !p.alive) continue;
    const g = p.gold * E.strategicResourceBurn;
    p.gold -= g;
    p.iron -= p.iron * E.strategicResourceBurn;
    gold += g;
  }
  return gold;
}
/** Opinion an ally needs of `from` before helping: this much less (Diplomatic Corps). */
export function techAllyOpinionDiscount(state: GameState, from: number): number {
  return techOf(state, from, 'diplomaticCorps') ? E.diploOpinionDiscount : 0;
}
/** Troops / gold an ally sends `friend` x (Diplomatic Corps). */
export function techAllyAidMul(state: GameState, friend: number): number {
  return techOf(state, friend, 'diplomaticCorps') ? E.diploAidMult : 1;
}
/** Ally request cooldown x (Diplomatic Corps). */
export function techAllyAskCooldownMul(state: GameState, from: number): number {
  return techOf(state, from, 'diplomaticCorps') ? E.diploAskCooldown : 1;
}
/** Mercenary price x (Conscription). */
export function techMercCostMul(state: GameState, pid: number): number {
  return techOf(state, pid, 'conscription') ? E.conscriptionMercCost : 1;
}
/**
 * Tank division modifiers for the tank-division code: cost x (Railways), speed and depth x (Blitz Tactics), local
 * defence x (Trench Warfare).
 */
export function tankDivisionMods(state: GameState, pid: number): { costMul: number; speedMul: number; depthMul: number; defenseMul: number } {
  return {
    costMul: techOf(state, pid, 'railways') ? E.railwaysTankCost : 1,
    speedMul: techOf(state, pid, 'blitzTactics') ? E.blitzDivisionSpeed : 1,
    depthMul: techOf(state, pid, 'blitzTactics') ? E.blitzDivisionDepth : 1,
    defenseMul: techOf(state, pid, 'trenchWarfare') ? E.trenchDivisionDefense : 1,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Navy: Carriers (warships shoot down planes) and Submarines (hidden warships)
// ---------------------------------------------------------------------------------------------------------------

/** Per-player gold-use / tech timers (created on first use; hashed). */
export function spendState(p: Player): SpendState {
  if (!p.spend) p.spend = { mercRecent: 0, mercWindowTick: 0, bondsUntil: 0, bondsReadyTick: 0, carrierReadyTick: 0 };
  return p.spend;
}
function hostileTo(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/**
 * Carriers: after SAMs and fighters (units.ts interceptThreats), each player's carriers (warships of the carrier
 * variant, variants.ts) shoot down one hostile bomber or cargo plane within carrierRadius of any of them, then wait
 * carrierCooldown seconds divided by its carrier count (at most 4). Threats are handled in the given order (already sorted by threat).
 */
export function interceptByCarriers(state: GameState, threats: readonly Unit[], units: readonly Unit[]): void {
  if (!threats.length) return;
  let carriers: Map<number, Unit[]> | null = null;
  for (const u of units) {
    if (u.type !== 'warship' || u.hp <= 0 || u.variant !== 'carrier') continue; // carrier variant (variants.ts)
    carriers ??= new Map();
    let l = carriers.get(u.owner);
    if (!l) carriers.set(u.owner, (l = []));
    l.push(u);
  }
  if (!carriers) return;
  const r2 = E.carrierRadius * E.carrierRadius;
  for (const t of threats) {
    if (t.hp <= 0 || (t.type !== 'bomber' && t.type !== 'transportPlane')) continue;
    for (const [owner, ships] of carriers) {
      const p = state.players[owner];
      if (!p?.alive || !hostileTo(state, t.owner, owner)) continue;
      const ss = spendState(p);
      if (ss.carrierReadyTick > state.tick) continue;
      const near = ships.find((s) => (s.x - t.x) * (s.x - t.x) + (s.y - t.y) * (s.y - t.y) <= r2);
      if (!near) continue;
      ss.carrierReadyTick = state.tick + Math.ceil((E.carrierCooldown / Math.min(4, ships.length)) * TICKS_PER_SECOND);
      state.effects.push({ kind: 'shot', x: near.x + 0.5, y: near.y + 0.5, x2: t.x + 0.5, y2: t.y + 0.5, radius: 0.5, tick: state.tick });
      if (nightDodges(state, t, owner)) break; // Night Bombing (specials.ts)
      t.hp -= 1;
      if (t.hp <= 0) {
        t.hp = 0;
        const aboard = t.troops.infantry + t.troops.armor + t.troops.artillery;
        if (aboard > 0) {
          state.players[t.owner].stats.troopsLost += aboard;
          p.stats.troopsKilled += aboard;
          t.troops = { infantry: 0, armor: 0, artillery: 0 };
        }
        state.effects.push({ kind: 'explosion', x: t.x + 0.5, y: t.y + 0.5, radius: 1.5, tick: state.tick });
        const what = t.type === 'bomber' ? 'bomber' : 'cargo plane';
        addEvent(state, 'unitLost', `${p.name}'s carrier fighters shot down a ${what} of ${state.players[t.owner].name}`, [t.owner, owner], -1);
      }
      break;
    }
  }
}

/**
 * Submarines: may `viewer` see unit u? Everything is visible except submarines (warships of the submarine variant) to
 * a viewer that is not their owner, not allied with it, has no destroyer sonar or recon over them (variants.ts) and no
 * own ship or coast within submarineRevealRange (the client hides them,
 * the minimap too). Cheap enough for the renderer (ships of the viewer, then coast tiles in a small box).
 */
export function unitVisibleTo(state: GameState, viewer: number, u: Unit): boolean {
  if (u.type !== 'warship' || u.owner === viewer || u.variant !== 'submarine') return true; // submarine variant (variants.ts)
  if (viewer <= 0) return true; // spectators see everything
  if (areAllied(state, viewer, u.owner)) return true;
  if (subRevealedTo(state, viewer, u)) return true; // destroyer sonar, recon flights (variants.ts)
  const r = E.submarineRevealRange;
  const r2 = r * r;
  for (const s of state.units) {
    if (s.owner !== viewer || s.hp <= 0 || (s.type !== 'warship' && s.type !== 'transport' && s.type !== 'tradeShip')) continue;
    if ((s.x - u.x) * (s.x - u.x) + (s.y - u.y) * (s.y - u.y) <= r2) return true;
  }
  const map = state.map;
  const w = map.width;
  const cx = Math.round(u.x);
  const cy = Math.round(u.y);
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y += 2) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x += 2) {
      const i = y * w + x;
      if (map.owner[i] === viewer && (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) return true;
    }
  }
  return earlyWarningSees(state, viewer, u); // Early Warning (specials.ts): farther from the coast and air sites
}
