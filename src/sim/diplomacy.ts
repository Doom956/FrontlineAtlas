// Alliances, requests, betrayal, opinion, gifts, embargoes.
import {
  ALLIANCE_DURATION,
  ALLIANCE_REQUEST_TIMEOUT,
  BETRAYAL_OPINION_PENALTY,
  TICKS_PER_SECOND,
  TRAITOR_DURATION,
} from './config';
import { addEvent } from './state';
import type { ActionResult, GameState } from './types';

/** Alliances may be renewed (request again) during their last this-many seconds. */
export const ALLIANCE_RENEW_WINDOW = 60;
const OPINION_DRIFT = 0.3; // per second toward 0
const OPINION_UNDER_ATTACK = 1.5; // per second while being attacked by that player
const OPINION_ALLY_BONUS = 0.4; // per second while allied
const BORDER_CHECK_SECONDS = 10;
const BORDER_FRICTION_TILES = 40; // shared border tiles before friction starts
const BORDER_FRICTION = 2; // opinion drop per check for a long shared border

export function areAllied(state: GameState, a: number, b: number): boolean {
  if (a === b) return false;
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  for (const al of state.alliances) if (al.a === lo && al.b === hi) return true;
  return false;
}
export function isTraitor(state: GameState, playerId: number): boolean {
  return state.players[playerId].traitorUntil > state.tick;
}
export function changeOpinion(state: GameState, of: number, about: number, delta: number): void {
  if (of === about || of <= 0 || about <= 0) return;
  const row = state.opinion[of];
  if (!row || row[about] === undefined) return;
  row[about] = Math.max(-100, Math.min(100, row[about] + delta));
}

function findAlliance(state: GameState, a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return state.alliances.findIndex((al) => al.a === lo && al.b === hi);
}
function attacking(state: GameState, a: number, b: number): boolean {
  for (const at of state.attacks) {
    if ((at.attacker === a && at.target === b) || (at.attacker === b && at.target === a)) return true;
  }
  return false;
}
function validPair(state: GameState, a: number, b: number): string | null {
  const pa = state.players[a];
  const pb = state.players[b];
  if (!pa || !pb || a === 0 || b === 0) return 'No such nation';
  if (a === b) return 'Cannot ally with yourself';
  if (!pa.alive || !pb.alive) return 'That nation is gone';
  return null;
}

/** Creates a request; if `to` is an AI, it answers via ai.ts aiWantsAlliance on its next decision. */
export function requestAlliance(state: GameState, from: number, to: number): ActionResult {
  const bad = validPair(state, from, to);
  if (bad) return { ok: false, reason: bad };
  const idx = findAlliance(state, from, to);
  if (idx >= 0 && state.alliances[idx].expiresTick - state.tick > ALLIANCE_RENEW_WINDOW * TICKS_PER_SECOND) {
    return { ok: false, reason: 'Already allied' };
  }
  if (state.allianceRequests.some((r) => r.from === from && r.to === to)) return { ok: false, reason: 'Request already sent' };
  if (attacking(state, from, to)) return { ok: false, reason: 'You are at war with them' };
  // They already asked us: treat this as accepting.
  if (state.allianceRequests.some((r) => r.from === to && r.to === from)) return answerAlliance(state, from, to, true);
  state.allianceRequests.push({ from, to, expiresTick: state.tick + ALLIANCE_REQUEST_TIMEOUT * TICKS_PER_SECOND });
  const verb = idx >= 0 ? 'renew the alliance' : 'form an alliance';
  addEvent(state, 'allianceRequest', `${state.players[from].name} asks to ${verb} with ${state.players[to].name}`, [to], -1);
  return { ok: true };
}

export function answerAlliance(state: GameState, playerId: number, from: number, accept: boolean): ActionResult {
  const k = state.allianceRequests.findIndex((r) => r.from === from && r.to === playerId);
  if (k < 0) return { ok: false, reason: 'No such request' };
  state.allianceRequests.splice(k, 1);
  const bad = validPair(state, from, playerId);
  if (bad) return { ok: false, reason: bad };
  if (!accept) {
    changeOpinion(state, from, playerId, -5);
    addEvent(state, 'info', `${state.players[playerId].name} rejected the alliance with ${state.players[from].name}`, [from, playerId], -1);
    return { ok: true };
  }
  formAlliance(state, from, playerId);
  return { ok: true };
}

/** Forms (or renews) an alliance; attacks between the two end and their troops go home. */
export function formAlliance(state: GameState, a: number, b: number): void {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const expiresTick = state.tick + ALLIANCE_DURATION * TICKS_PER_SECOND;
  const idx = findAlliance(state, a, b);
  const renewed = idx >= 0;
  if (renewed) state.alliances[idx].expiresTick = expiresTick;
  else state.alliances.push({ a: lo, b: hi, expiresTick });
  state.allianceRequests = state.allianceRequests.filter((r) => !((r.from === a && r.to === b) || (r.from === b && r.to === a)));
  if (attacking(state, a, b)) {
    state.attacks = state.attacks.filter((at) => {
      const between = (at.attacker === a && at.target === b) || (at.attacker === b && at.target === a);
      if (!between) return true;
      const home = state.players[at.attacker];
      home.troops.infantry += at.troops.infantry;
      home.troops.armor += at.troops.armor;
      home.troops.artillery += at.troops.artillery;
      return false;
    });
  }
  changeOpinion(state, a, b, 10);
  changeOpinion(state, b, a, 10);
  const pa = state.players[a].name;
  const pb = state.players[b].name;
  addEvent(state, 'allianceFormed', renewed ? `${pa} and ${pb} renewed their alliance` : `${pa} and ${pb} are now allies`, [a, b], -1);
}

/** Ends an alliance early: breaker becomes traitor, opinions drop. */
export function breakAlliance(state: GameState, playerId: number, other: number): ActionResult {
  const idx = findAlliance(state, playerId, other);
  if (idx < 0) return { ok: false, reason: 'Not allied' };
  state.alliances.splice(idx, 1);
  const p = state.players[playerId];
  p.traitorUntil = state.tick + TRAITOR_DURATION * TICKS_PER_SECOND;
  changeOpinion(state, other, playerId, -BETRAYAL_OPINION_PENALTY);
  // Every other nation trusts the traitor less.
  for (const q of state.players) {
    if (q.id === 0 || q.id === playerId || q.id === other || !q.alive) continue;
    changeOpinion(state, q.id, playerId, -BETRAYAL_OPINION_PENALTY / 2);
  }
  addEvent(state, 'allianceBroken', `${p.name} broke their alliance with ${state.players[other].name} and is now a traitor`, [playerId, other], -1);
  return { ok: true };
}

export function gift(state: GameState, from: number, to: number, gold: number, troops: number): ActionResult {
  const pf = state.players[from];
  const pt = state.players[to];
  if (!pt || to === 0 || to === from) return { ok: false, reason: 'Invalid recipient' };
  if (!pt.alive || !pt.spawned) return { ok: false, reason: 'That nation is gone' };
  if (!Number.isFinite(gold) || !Number.isFinite(troops) || gold < 0 || troops < 0) return { ok: false, reason: 'Invalid amount' };
  gold = Math.floor(gold);
  troops = Math.floor(troops);
  if (gold === 0 && troops === 0) return { ok: false, reason: 'Nothing to give' };
  if (gold > pf.gold) return { ok: false, reason: 'Not enough gold' };
  if (troops > pf.troops.infantry) return { ok: false, reason: 'Not enough infantry' };
  pf.gold -= gold;
  pt.gold += gold;
  pf.troops.infantry -= troops;
  pt.troops.infantry += troops;
  changeOpinion(state, to, from, Math.min(25, gold / 100 + troops / 300));
  const parts = [gold > 0 ? `${gold} gold` : '', troops > 0 ? `${troops} infantry` : ''].filter(Boolean).join(' and ');
  addEvent(state, 'info', `${pf.name} sent ${parts} to ${pt.name}`, [from, to], -1);
  return { ok: true };
}

export function toggleEmbargo(state: GameState, playerId: number, other: number): ActionResult {
  const p = state.players[playerId];
  if (!state.players[other] || other === 0 || other === playerId) return { ok: false, reason: 'Invalid nation' };
  const k = p.embargoes.indexOf(other);
  if (k >= 0) p.embargoes.splice(k, 1);
  else {
    p.embargoes.push(other);
    changeOpinion(state, other, playerId, -10);
  }
  return { ok: true };
}

/** True if trade ships may run between a and b (no embargo either way, both alive, not attacking each other). */
export function canTrade(state: GameState, a: number, b: number): boolean {
  if (a === b || a === 0 || b === 0) return false;
  const pa = state.players[a];
  const pb = state.players[b];
  if (!pa || !pb || !pa.alive || !pb.alive) return false;
  if (pa.embargoes.includes(b) || pb.embargoes.includes(a)) return false;
  return !attacking(state, a, b);
}

/** Expire alliances/requests, slow opinion drift toward 0, border friction. */
export function updateDiplomacy(state: GameState): void {
  const t = state.tick;
  if (state.allianceRequests.length) {
    state.allianceRequests = state.allianceRequests.filter((r) => r.expiresTick > t);
  }
  if (state.alliances.length) {
    const kept = [];
    for (const al of state.alliances) {
      if (al.expiresTick > t) kept.push(al);
      else addEvent(state, 'allianceExpired', `The alliance of ${state.players[al.a].name} and ${state.players[al.b].name} has expired`, [al.a, al.b], -1);
    }
    if (kept.length !== state.alliances.length) state.alliances = kept;
  }

  if (t % TICKS_PER_SECOND !== 0) return;
  // Once per second: opinion drift, war and alliance effects.
  const op = state.opinion;
  const n = state.players.length;
  for (let a = 1; a < n; a++) {
    if (!state.players[a].alive) continue;
    const row = op[a];
    for (let b = 1; b < n; b++) {
      const v = row[b];
      if (v > 0) row[b] = Math.max(0, v - OPINION_DRIFT);
      else if (v < 0) row[b] = Math.min(0, v + OPINION_DRIFT);
    }
  }
  for (const at of state.attacks) {
    if (at.target !== 0) changeOpinion(state, at.target, at.attacker, -OPINION_UNDER_ATTACK);
  }
  for (const al of state.alliances) {
    changeOpinion(state, al.a, al.b, OPINION_ALLY_BONUS);
    changeOpinion(state, al.b, al.a, OPINION_ALLY_BONUS);
  }
  if ((t / TICKS_PER_SECOND) % BORDER_CHECK_SECONDS === 0) borderFriction(state);
}

/** Long shared borders breed distrust (full map scan, every BORDER_CHECK_SECONDS). */
function borderFriction(state: GameState): void {
  const { width: w, height: h, owner } = state.map;
  const n = state.players.length;
  const shared = new Uint32Array(n * n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const o = owner[i];
      if (o === 0) continue;
      if (x < w - 1) {
        const r = owner[i + 1];
        if (r !== 0 && r !== o) shared[o * n + r]++;
      }
      if (y < h - 1) {
        const d = owner[i + w];
        if (d !== 0 && d !== o) shared[o * n + d]++;
      }
    }
  }
  for (let a = 1; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const len = shared[a * n + b] + shared[b * n + a];
      if (len < BORDER_FRICTION_TILES || areAllied(state, a, b)) continue;
      changeOpinion(state, a, b, -BORDER_FRICTION);
      changeOpinion(state, b, a, -BORDER_FRICTION);
    }
  }
}
