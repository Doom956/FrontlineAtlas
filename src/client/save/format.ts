// Single-player save file (docs/DESIGN.md, "Save and continue"). A save is not a picture of the game state: it holds
// the settings (with the map seed), the ordered list of the player's actions with the tick each one was applied at,
// and a few state hashes. Loading builds the game again from the settings and replays the actions (replay.ts); the
// sim is deterministic (the same property online lockstep relies on), so the replay ends in the same state. The
// hashes prove it: a save made by a build with other rules or code is caught at the first hash that differs.
// Pure data and checks only (no DOM, no storage): store.ts reads and writes it.
import { clientBuildId } from '../../net/client';
import { TICKS_PER_SECOND } from '../../sim/config';
import { mapLabel } from '../../sim/setup';
import type { Action, GameSettings } from '../../sim/types';

/** Bumped whenever the shape of SaveData changes. */
export const SAVE_FORMAT = 1;

/** One recorded action: [tick it was applied at (state.tick then), the action]. */
export type LogEntry = [tick: number, action: Action];

/** A state hash after `n` log entries were applied at tick `t` (hashState). */
export interface Checkpoint {
  t: number;
  n: number;
  h: number;
}

/** What the start page shows without replaying anything. */
export interface SaveMeta {
  /** "Continents, medium" or the world map's name */
  map: string;
  /** game minutes since the war began */
  minutes: number;
  /** the player's share of all land, 0..1 */
  land: number;
  /** average ms per sim tick on the machine that saved (to guess the load time) */
  tickMs: number;
}

export interface SaveData {
  format: number;
  /** clientBuildId(): protocol version + balance data (or VITE_BUILD_ID) */
  build: string;
  /** Date.now() of the save */
  savedAt: number;
  settings: GameSettings;
  /** state.tick when saved */
  tick: number;
  log: LogEntry[];
  /** in log order; the last one is the state at the save */
  checks: Checkpoint[];
  meta: SaveMeta;
}

/** Result of reading a save: usable, from another version (only discard), or unreadable. */
export type SaveSlot =
  | { status: 'ok'; save: SaveData }
  | { status: 'old'; meta: SaveMeta | null; savedAt: number | null }
  | { status: 'broken' };

let buildIdCache: string | null = null;
/** The build stamp written into saves (cached: it hashes all balance data). */
export function saveBuildId(): string {
  buildIdCache ??= clientBuildId();
  return buildIdCache;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readMeta(v: unknown): SaveMeta | null {
  if (!isObj(v)) return null;
  if (typeof v.map !== 'string' || !isNum(v.minutes) || !isNum(v.land) || !isNum(v.tickMs)) return null;
  return { map: v.map.slice(0, 80), minutes: Math.max(0, v.minutes), land: Math.max(0, Math.min(1, v.land)), tickMs: Math.max(0, v.tickMs) };
}

/** Checks a parsed save. The log must be in tick order and every checkpoint must point inside it. */
export function checkSave(v: unknown, build = saveBuildId()): SaveSlot {
  if (!isObj(v)) return { status: 'broken' };
  const meta = readMeta(v.meta);
  const savedAt = isNum(v.savedAt) ? v.savedAt : null;
  if (v.format !== SAVE_FORMAT || v.build !== build) return { status: 'old', meta, savedAt };
  if (!meta || savedAt === null || !isObj(v.settings) || !isCount(v.tick) || !Array.isArray(v.log) || !Array.isArray(v.checks)) return { status: 'broken' };
  const tick = v.tick;
  let last = 0;
  for (const e of v.log as unknown[]) {
    if (!Array.isArray(e) || e.length !== 2 || !isCount(e[0]) || !isObj(e[1]) || typeof e[1].type !== 'string') return { status: 'broken' };
    if (e[0] < last || e[0] > tick) return { status: 'broken' };
    last = e[0];
  }
  let prev: Checkpoint | null = null;
  for (const c of v.checks as unknown[]) {
    if (!isObj(c) || !isCount(c.t) || !isCount(c.n) || !isNum(c.h)) return { status: 'broken' };
    if (c.t > tick || c.n > v.log.length) return { status: 'broken' };
    if (prev && (c.t < prev.t || c.n < prev.n)) return { status: 'broken' };
    prev = { t: c.t, n: c.n, h: c.h };
  }
  return { status: 'ok', save: v as unknown as SaveData };
}

/** Reads a save from its JSON text (never throws). */
export function parseSave(text: string | null, build = saveBuildId()): SaveSlot | null {
  if (text === null) return null;
  try {
    return checkSave(JSON.parse(text), build);
  } catch {
    return { status: 'broken' };
  }
}

/** Map name for the start page: "Continents, medium" or "Europe". */
export function saveMapName(settings: GameSettings): string {
  try {
    return mapLabel(settings.map);
  } catch {
    return 'Unknown map';
  }
}

/** Seconds a load is expected to take: replaying every tick at the speed the saving machine ran them. */
export function loadSeconds(save: Pick<SaveData, 'tick' | 'meta'>): number {
  // a floor for machines that never measured (tests, very short games)
  const ms = Math.max(1, save.meta.tickMs || 3);
  return (save.tick * ms) / 1000;
}

/** A load longer than this gets a note on the start page ("Takes about 3 min to load"). */
export const LONG_LOAD_SECONDS = 45;

/** "Takes about 2 min to load" for long loads, else null. */
export function loadNote(seconds: number): string | null {
  if (seconds < LONG_LOAD_SECONDS) return null;
  const min = Math.round(seconds / 60);
  return min <= 1 ? 'Takes about 1 min to load' : `Takes about ${min} min to load`;
}

/** "Saved just now", "Saved 5 min ago", "Saved 3 h ago", "Saved 2 days ago". */
export function savedAgo(savedAt: number, now: number): string {
  const s = Math.max(0, (now - savedAt) / 1000);
  if (s < 60) return 'Saved just now';
  const min = Math.floor(s / 60);
  if (min < 60) return `Saved ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Saved ${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'Saved yesterday' : `Saved ${d} days ago`;
}

/** "24 min played, 18% of the land" */
export function saveFacts(meta: SaveMeta): string {
  const min = Math.floor(meta.minutes);
  const played = min < 1 ? 'Just started' : min < 60 ? `${min} min played` : `${Math.floor(min / 60)} h ${min % 60} min played`;
  const pct = meta.land > 0 && meta.land < 0.01 ? '<1' : String(Math.round(meta.land * 100));
  return `${played}, ${pct}% of the land`;
}

/** "3:05" style remaining time for the loading bar. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Game minutes covered by `ticks` (the loading bar's "12 of 24 min"). */
export function ticksToMinutes(ticks: number): number {
  return ticks / TICKS_PER_SECOND / 60;
}
