// What the HUD shows about doctrines, without the DOM: the state of your doctrine (locked, none, adapting, active),
// the timers in game seconds, the switch line, and whether you know another nation's doctrine. The sim decides
// everything (src/sim/doctrines.ts); this only reads it.
import { DOCTRINES, DOCTRINE_ADAPT_SECONDS, DOCTRINE_SWITCH_COOLDOWN, TICKS_PER_SECOND } from '../sim/config';
import { hasIntel } from '../sim/buildings';
import { borders } from '../sim/combat';
import {
  doctrineAdaptLeft,
  doctrineCooldownLeft,
  doctrineNextLevelIn,
  doctrineSwitchCost,
  doctrineTicks,
  doctrineUnlocked,
  doctrineUnlockSeconds,
  recommendDoctrines,
} from '../sim/doctrines';
import { DOCTRINE_IDS, type DoctrineId, type GameState, type Player } from '../sim/types';
import { hasLineIcon } from './hud/glyph';
import { formatCount } from './render/common';

export const DOCTRINE_ORDER: readonly DoctrineId[] = DOCTRINE_IDS;
/** The hotkey that opens the picker (all single letters are taken: WASD pan, the rest build, strike or open drawers). */
export const DOCTRINE_KEY = 'Shift+D';

/** Line icon name for a doctrine (the config's icon when it is a HUD line icon, else our 'doctrine-<id>'). */
export function doctrineIcon(id: DoctrineId): string {
  const ic = DOCTRINES[id].icon;
  return ic && hasLineIcon(ic) ? ic : `doctrine-${id}`;
}

/** Game seconds a config duration lasts in this game (the sim's timers: half in a fast game). */
export function scaledSeconds(s: GameState, sec: number): number {
  return doctrineTicks(s, sec) / TICKS_PER_SECOND;
}

/** "45 s", "2 min", "6:20". */
export function fmtDuration(sec: number): string {
  const v = Math.max(0, Math.round(sec));
  if (v < 90) return `${v} s`;
  if (v % 60 === 0) return `${v / 60} min`;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}
/** "5:00" as on the clock. */
export function fmtClock(sec: number): string {
  const v = Math.max(0, Math.round(sec));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

export type DoctrinePhase = 'locked' | 'none' | 'adapting' | 'active';

export interface DoctrineStatus {
  phase: DoctrinePhase;
  /** chosen doctrine (also while adapting to it) */
  id: DoctrineId | null;
  level: 0 | 1 | 2 | 3;
  /** game time doctrines unlock */
  unlockAt: number;
  /** adapting: seconds left and the share done (0..1) */
  adaptLeft: number;
  adaptDone: number;
  /** seconds until the next level (0 = level 3 or none) */
  nextLevelIn: number;
  /** seconds until a switch is allowed again (0 = now) */
  cooldownLeft: number;
}

export function doctrineStatus(s: GameState, me: Player): DoctrineStatus {
  const d = me.doctrine;
  const base: DoctrineStatus = { phase: 'locked', id: d?.id ?? null, level: d?.level ?? 0, unlockAt: doctrineUnlockSeconds(s), adaptLeft: 0, adaptDone: 1, nextLevelIn: 0, cooldownLeft: 0 };
  if (!d || s.phase !== 'playing' || !doctrineUnlocked(s, me.id)) return base;
  if (!d.id) return { ...base, phase: 'none' };
  const adaptLeft = doctrineAdaptLeft(s, me.id);
  const adaptLen = Math.max(1e-6, (d.adaptUntilTick - d.chosenTick) / TICKS_PER_SECOND);
  return {
    ...base,
    phase: adaptLeft > 0 ? 'adapting' : 'active',
    adaptLeft,
    adaptDone: adaptLeft > 0 ? Math.min(1, Math.max(0, 1 - adaptLeft / adaptLen)) : 1,
    nextLevelIn: doctrineNextLevelIn(s, me.id) ?? 0,
    cooldownLeft: doctrineCooldownLeft(s, me.id),
  };
}

/** What choosing `id` would do now: allowed or why not, the cost and the one-line summary for the confirm area. */
export interface ChoiceInfo {
  ok: boolean;
  /** first choice or a switch */
  switching: boolean;
  cost: number;
  /** "Switch: 1.2k gold, 45 s without a doctrine; then 2 min cooldown" / "Free. Switching later costs gold." */
  line: string;
  /** why not, when !ok */
  reason: string;
  /** button label: "Choose Blitz" / "Switch to Siege" */
  label: string;
}

export function choiceInfo(s: GameState, me: Player, id: DoctrineId): ChoiceInfo {
  const st = doctrineStatus(s, me);
  const name = DOCTRINES[id].name;
  const switching = st.id !== null;
  const cost = switching ? doctrineSwitchCost(s, me.id) : 0;
  const adapt = fmtDuration(scaledSeconds(s, DOCTRINE_ADAPT_SECONDS));
  const cool = fmtDuration(scaledSeconds(s, DOCTRINE_SWITCH_COOLDOWN));
  const line = switching
    ? `Switch: ${formatCount(cost)} gold, ${adapt} without a doctrine; then ${cool} cooldown`
    : `The first choice is free and works at once. Switching later costs gold.`;
  const label = switching ? `Switch to ${name}` : `Choose ${name}`;
  let reason = '';
  if (st.phase === 'locked') reason = `Doctrines unlock at ${fmtClock(st.unlockAt)}`;
  else if (st.id === id) reason = 'This is your doctrine';
  else if (st.cooldownLeft > 0) reason = `You can switch again in ${fmtDuration(st.cooldownLeft)}`;
  else if (me.gold < cost) reason = `Needs ${formatCount(cost)} gold, you have ${formatCount(me.gold)}`;
  return { ok: reason === '', switching, cost, line, reason, label };
}

/** The top recommendations for this player (id -> reason); empty before unlock is fine too. */
export function recommendations(s: GameState, me: Player): Map<DoctrineId, string> {
  const out = new Map<DoctrineId, string>();
  try {
    for (const r of recommendDoctrines(s, me.id).slice(0, 3)) out.set(r.id, r.reason);
  } catch {
    /* no land yet */
  }
  return out;
}

/**
 * Another nation's doctrine if you know it: the sim tells nations that border it or watch it (a Watchtower near it, an
 * alliance), so the card and the standings show it under the same rule. null = none or unknown.
 */
export function knownDoctrine(s: GameState, viewer: number, pid: number): { id: DoctrineId; level: number; adapting: boolean } | null {
  const p = s.players[pid];
  const d = p?.doctrine;
  if (!p || !d || !d.id) return null;
  if (pid !== viewer && !hasIntel(s, viewer, pid) && !borders(s, viewer, pid)) return null;
  return { id: d.id, level: d.level, adapting: s.tick < d.adaptUntilTick };
}

/** "Blitz, level 2" (+ ", adapting"). */
export function doctrineLabel(id: DoctrineId, level: number, adapting = false): string {
  return `${DOCTRINES[id].name}${adapting ? ', adapting' : level > 0 ? `, level ${level}` : ''}`;
}

/** Level-up toast: "Blitz level 2: armor ignores some terrain". */
export function levelUpText(id: DoctrineId, level: number): string {
  const line = DOCTRINES[id].levels[Math.max(0, Math.min(2, level - 1))] ?? '';
  return `${DOCTRINES[id].name} level ${level}: ${line.charAt(0).toLowerCase()}${line.slice(1).replace(/\.$/, '')}`;
}
