// Defense Mastery (Arsenal Defense row, tier 4; config COUNTER; DESIGN section 7, Defense): the Counteroffensive and
// Hardened shelters.
//
// Counteroffensive. Every troop an enemy attack or spearhead loses taking a tile of yours that a working Fort of yours
// covers (fortified land, buildings.isFortified) fills your meter (Player.counterMeter, 0..1) by
//   loss / max(COUNTER.fillMin, COUNTER.fillShare x your whole army)
// and one that runs dry or is stopped there adds COUNTER.failBonus (combat.ts stepAttack, tanks.ts stepSpearhead call
// counterBleed). The nation that bled last is the one you strike back at (Player.counterFoe). Full meter: Action
// counteroffensive sends COUNTER.troopShare of your home troops at that nation along your shared border (an ordinary
// combat.ts attack, focused next to the Fort nearest to it) and drives your idle tank divisions near a Fort into a
// spearhead there; for COUNTER.seconds every attack and spearhead of yours on that nation runs COUNTER.speedMul x
// faster and loses COUNTER.lossMul x (spearheads also go COUNTER.depthMul x deeper): combat.ts and tanks.ts read
// counterActive. The meter empties. Shown: a wide arrow sweeping from the Fort with dust ('counterPush' effect).
//
// Hardened shelters: an atom bomb (units.ts atomImpact) on land of a nation with Defense Mastery that one of its
// working Forts covers kills COUNTER.shelterMul x the troops there, and its buildings there lose COUNTER.shelterMul hp
// (knocked out for COUNTER.shelterKnockSeconds; destroyed at 0) instead of being wiped out. The coverage is judged
// before the blast (a Fort covers itself). The atom aiming preview reads shelterPreview.
//
// AI (aiCounter, every decision): an AI with a full meter strikes back once it keeps COUNTER.aiKeepHome of its cap at
// home after sending; Easy AIs never at a human. Deterministic: no RNG, fixed orders.
import { buildingsOf, fortRadius, isDisabled, isFortified } from './buildings';
import { COUNTER, TICKS_PER_SECOND } from './config';
import { aiAttackLevel } from './aiattack';
import { frontTiles, launchAttack, wholeArmy } from './combat';
import { areAllied } from './diplomacy';
import { forEachInRadius } from './grid';
import { atPeace, peaceReason } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { moveTankDivisions } from './tanks';
import { TROOP_TYPES, isTribe } from './types';
import type { ActionResult, Building, GameState, Troops } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

/** True if pid owns Defense Mastery. */
export function hasDefenseMastery(state: GameState, pid: number): boolean {
  const p = pid > 0 ? state.players[pid] : undefined;
  return !!p && hasTech(p, 'defenseMastery');
}

/** pid's Counteroffensive meter, 0..1. */
export function counterMeter(state: GameState, pid: number): number {
  return state.players[pid]?.counterMeter ?? 0;
}

/** Seconds left of pid's running Counteroffensive (0 = none). */
export function counterSecondsLeft(state: GameState, pid: number): number {
  const u = state.players[pid]?.counterUntil ?? 0;
  return u > state.tick ? (u - state.tick) / TICKS_PER_SECOND : 0;
}

/** True while pid's Counteroffensive at `foe` runs (its attacks and spearheads on foe are faster and cheaper). */
export function counterActive(state: GameState, pid: number, foe: number): boolean {
  if (pid <= 0 || foe <= 0) return false;
  const p = state.players[pid];
  return !!p && p.counterFoe === foe && (p.counterUntil ?? 0) > state.tick;
}
/** Front speed factor of pid's attacks and spearheads on `foe` (COUNTER.speedMul while the push runs). */
export function counterSpeedMul(state: GameState, pid: number, foe: number): number {
  return counterActive(state, pid, foe) ? COUNTER.speedMul : 1;
}
/** Loss factor of pid's attacks and spearheads on `foe`. */
export function counterLossMul(state: GameState, pid: number, foe: number): number {
  return counterActive(state, pid, foe) ? COUNTER.lossMul : 1;
}
/** Spearhead depth factor. */
export function counterDepthMul(state: GameState, pid: number, foe: number): number {
  return counterActive(state, pid, foe) ? COUNTER.depthMul : 1;
}

/** True if a hit on `tile` of `defender` fills its meter: it owns Defense Mastery and a working Fort covers the tile. */
export function bleedsOnForts(state: GameState, defender: number, tile: number): boolean {
  return hasDefenseMastery(state, defender) && isFortified(state, tile, defender);
}

/**
 * `attacker` lost `loss` troops on `defender`'s fortified land (callers check bleedsOnForts); `failed` = the attack or
 * spearhead ended there (ran dry, stopped by a fort). Fills the defender's meter and names the attacker as its foe.
 */
export function counterBleed(state: GameState, defender: number, attacker: number, loss: number, failed: boolean): void {
  const p = state.players[defender];
  if (!p || attacker <= 0 || attacker === defender || !p.alive) return;
  if ((p.counterUntil ?? 0) > state.tick && p.counterFoe === attacker) return; // the push is running: no refill meanwhile
  const before = p.counterMeter ?? 0;
  const need = Math.max(COUNTER.fillMin, COUNTER.fillShare * wholeArmy(state, defender));
  const add = Math.max(0, loss) / need + (failed ? COUNTER.failBonus : 0);
  if (add <= 0) return;
  p.counterMeter = Math.min(1, before + add);
  p.counterFoe = attacker;
  if (before < 1 && p.counterMeter >= 1) {
    addEvent(state, 'info', `${p.name}'s forts held: Counteroffensive ready against ${state.players[attacker].name}`, [defender], -1);
  }
}

/** Own working Forts of pid (finished, not knocked out), by id. */
function workingForts(state: GameState, pid: number): Building[] {
  return buildingsOf(state, pid, 'fort')
    .filter((b) => b.buildLeft <= 0 && !isDisabled(state, b) && state.map.owner[b.tile] === pid)
    .sort((a, b) => a.id - b.id);
}

/**
 * Where pid's push at `foe` starts: the foe's border tile nearest to one of pid's working Forts (the Fort's tile and
 * the border tile), or null when they share no land border.
 */
export function counterFocus(state: GameState, pid: number, foe: number): { fort: number; tile: number } | null {
  const front = frontTiles(state, pid, foe, 4000);
  if (!front.length) return null;
  const forts = workingForts(state, pid);
  const w = state.map.width;
  let best: { fort: number; tile: number; d: number } | null = null;
  for (const t of front) {
    const tx = t % w;
    const ty = (t / w) | 0;
    for (const f of forts) {
      const dx = (f.tile % w) - tx;
      const dy = ((f.tile / w) | 0) - ty;
      const d = dx * dx + dy * dy;
      if (!best || d < best.d || (d === best.d && t < best.tile)) best = { fort: f.tile, tile: t, d };
    }
  }
  if (best) return { fort: best.fort, tile: best.tile };
  return { fort: front[0], tile: front[0] };
}

/** Why pid cannot launch the Counteroffensive now ('' = it can). Pure read (the button's disabled line). */
export function counterBlock(state: GameState, pid: number): string {
  const p = state.players[pid];
  if (!p || pid <= 0 || !p.alive) return 'No such player';
  if (!hasTech(p, 'defenseMastery')) return 'Needs Defense Mastery';
  const left = counterSecondsLeft(state, pid);
  if (left > 0) return `Counteroffensive under way: ${Math.ceil(left)} s left`;
  const m = p.counterMeter ?? 0;
  if (m < 1) return `Meter ${Math.floor(m * 100)}%: it fills when enemy attacks bleed on your fortified land`;
  const foe = p.counterFoe ?? 0;
  const q = foe > 0 ? state.players[foe] : undefined;
  if (!q || !q.alive) return 'The attacker is gone';
  if (areAllied(state, pid, foe)) return `${q.name} is your ally now`;
  const peace = peaceReason(state, pid, foe);
  if (peace) return peace;
  if (!workingForts(state, pid).length) return 'Needs a working Fort';
  if (!counterFocus(state, pid, foe)) return `No land border with ${q.name}`;
  return '';
}

/** The troops a Counteroffensive of pid would send (COUNTER.troopShare of every type at home). */
export function counterTroops(state: GameState, pid: number): Troops {
  const p = state.players[pid];
  const out: Troops = { infantry: 0, armor: 0, artillery: 0 };
  if (!p) return out;
  for (const k of TROOP_TYPES) out[k] = Math.floor(p.troops[k] * COUNTER.troopShare);
  return out;
}

/**
 * Action counteroffensive: the push (see the file comment). Sends the attack, starts the COUNTER.seconds window, sends
 * idle tank divisions near a Fort, empties the meter, shows the arrow and tells both sides.
 */
export function launchCounteroffensive(state: GameState, pid: number): ActionResult {
  const why = counterBlock(state, pid);
  if (why) return FAIL(why);
  const p = state.players[pid];
  const foe = p.counterFoe!;
  const focus = counterFocus(state, pid, foe)!;
  // the window first: the attack's first tick already runs faster and cheaper
  const until = state.tick + Math.round(COUNTER.seconds * TICKS_PER_SECOND);
  const prevUntil = p.counterUntil;
  p.counterUntil = until;
  const r = launchAttack(state, pid, focus.tile, counterTroops(state, pid));
  if (!r.ok) {
    if (prevUntil === undefined) delete p.counterUntil;
    else p.counterUntil = prevUntil;
    return r;
  }
  p.counterMeter = 0;
  // idle tank divisions near a working Fort join with a spearhead at the same border tile
  const w = state.map.width;
  const forts = workingForts(state, pid);
  const ids: number[] = [];
  for (const u of state.units) {
    if (u.type !== 'tankDivision' || u.owner !== pid || u.hp <= 0 || u.state === 3) continue;
    for (const f of forts) {
      const r2 = fortRadius(state, f) + COUNTER.divisionReach;
      const dx = (f.tile % w) - u.x;
      const dy = ((f.tile / w) | 0) - u.y;
      if (dx * dx + dy * dy <= r2 * r2) {
        ids.push(u.id);
        break;
      }
    }
  }
  if (ids.length) moveTankDivisions(state, pid, ids, focus.tile);
  // the arrow: from the Fort through the border tile, a dozen tiles deep
  const fx = (focus.fort % w) + 0.5;
  const fy = ((focus.fort / w) | 0) + 0.5;
  let dx = (focus.tile % w) + 0.5 - fx;
  let dy = ((focus.tile / w) | 0) + 0.5 - fy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 1e-6) {
    dx /= len;
    dy /= len;
  } else dx = 1;
  state.effects.push({ kind: 'counterPush', x: fx, y: fy, x2: (focus.tile % w) + 0.5 + dx * 12, y2: ((focus.tile / w) | 0) + 0.5 + dy * 12, radius: 6, tick: state.tick });
  const q = state.players[foe];
  addEvent(state, 'attackStarted', `${p.name} launched a Counteroffensive from its forts against ${q.name}`, isTribe(q) ? [pid] : [pid, foe], focus.tile);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Hardened shelters
// ---------------------------------------------------------------------------------------------------------------

/** True if `tile` of its owner is under hardened shelters (Defense Mastery and a working Fort of the owner covers it). */
export function sheltered(state: GameState, tile: number): boolean {
  const o = state.map.owner[tile];
  return o > 0 && bleedsOnForts(state, o, tile);
}

/** What an atom bomb at `tile` (radius r) would meet: sheltered tiles and buildings per owner. Pure read. */
export function shelterPreview(state: GameState, tile: number, r: number): { tiles: number; buildings: number; owners: number[]; mask: number[] } {
  const out = { tiles: 0, buildings: 0, owners: [] as number[], mask: [] as number[] };
  const holders = new Set<number>();
  for (const p of state.players) if (p.id > 0 && p.alive && hasTech(p, 'defenseMastery')) holders.add(p.id);
  if (!holders.size) return out;
  const seen = new Set<number>();
  forEachInRadius(state.map, tile, r, (i) => {
    const o = state.map.owner[i];
    if (!holders.has(o) || !isFortified(state, i, o)) return;
    out.tiles++;
    out.mask.push(i);
    if (state.map.building[i]) out.buildings++;
    seen.add(o);
  });
  out.owners = [...seen].sort((a, b) => a - b);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

/** AI: strike back once the meter is full (see the file comment). Returns true if it launched. */
export function aiCounter(state: GameState, id: number): boolean {
  const p = state.players[id];
  if (!p || p.isHuman || !p.alive || (p.counterMeter ?? 0) < 1 || !hasTech(p, 'defenseMastery')) return false;
  const foe = p.counterFoe ?? 0;
  const q = state.players[foe];
  if (!q || (aiAttackLevel(state) < 1 && q.isHuman)) return false; // Easy: never at a human
  if (atPeace(state, id, foe) || counterBlock(state, id)) return false;
  const t = counterTroops(state, id);
  const sent = t.infantry + t.armor + t.artillery;
  const home = p.troops.infantry + p.troops.armor + p.troops.artillery;
  if (home - sent < COUNTER.aiKeepHome * p.maxPop) return false;
  return launchCounteroffensive(state, id).ok;
}
