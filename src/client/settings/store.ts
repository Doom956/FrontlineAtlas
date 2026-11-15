// The player's settings (client only): sound, the map's look, the unit art, motion and graphics quality, kept in one
// place and saved in this browser (localStorage FA_SETTINGS_KEY, every access in try/catch). Read-only for the game:
// nothing here touches the sim, its hash or multiplayer.
//
// The first load with no saved settings reads the keys each part used to keep on its own (the sound volumes, the map
// look, the map effects switch), so a returning player keeps their picks; those old keys are left as they were.
// The advisor, the guide and the chat keep their own keys (hud/advisor.ts, guide/engine.ts, chat/store.ts): the
// guide's key also holds which tips were seen.
//
// Every change saves at once and tells the listeners (settings/apply.ts), so each part applies it without a reload.
import { AUDIO_STORAGE_KEY, DEFAULT_AUDIO_SETTINGS, LEGACY_AUDIO_STORAGE_KEY, migrateAudioSettings, parseAudioSettings } from '../audio';
import { ART_STYLES, MOTION_PRESETS, type ArtStyle, type MotionPreset } from '../art/artStyle';
import type { MapStyle } from '../render/mapStyle';

export const FA_SETTINGS_KEY = 'fa.settings.v1';
/** The keys the settings were kept under before this store (read once when FA_SETTINGS_KEY is missing). */
export const LEGACY_MAP_STYLE_KEY = 'fa.mapStyle';
export const LEGACY_FX_KEY = 'borderfall.fx.v1';

/** Graphics quality: Auto picks the light map only without a graphics card (render/glmap.ts softwareRenderer). */
export type Quality = 'auto' | 'high' | 'low';
/** Reduce motion: follow the device's setting, or always on, or always off. */
export type ReduceMotion = 'device' | 'on' | 'off';

export interface Settings {
  /** volumes 0..1 */
  master: number;
  sfx: number;
  music: number;
  muted: boolean;
  /** the map look; null = the build's default (render/mapStyle.ts) */
  mapStyle: MapStyle | null;
  /** one art style for every unit; null = the build's picks (art/artStyle.ts) */
  art: ArtStyle | null;
  /** one motion preset for every unit; null = the build's picks */
  motion: MotionPreset | null;
  /** map effects: flashes, splashes, blasts and the nuke shake (fx/) */
  effects: boolean;
  reduceMotion: ReduceMotion;
  quality: Quality;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  master: DEFAULT_AUDIO_SETTINGS.master,
  sfx: DEFAULT_AUDIO_SETTINGS.sfx,
  music: DEFAULT_AUDIO_SETTINGS.music,
  muted: DEFAULT_AUDIO_SETTINGS.muted,
  mapStyle: null,
  art: null,
  motion: null,
  effects: true,
  reduceMotion: 'device',
  quality: 'auto',
});

export type SettingKey = keyof Settings;
/** What each section's "Reset to defaults" puts back. */
export const SOUND_KEYS: readonly SettingKey[] = ['master', 'sfx', 'music', 'muted'];
export const DISPLAY_KEYS: readonly SettingKey[] = ['mapStyle', 'art', 'motion', 'effects', 'reduceMotion', 'quality'];

const MAP_STYLE_WORDS: readonly MapStyle[] = ['today', 'pixel', 'muted', 'ground'];
const QUALITIES: readonly Quality[] = ['auto', 'high', 'low'];
const REDUCE: readonly ReduceMotion[] = ['device', 'on', 'off'];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : d);
const oneOf = <T extends string>(list: readonly T[], v: unknown, d: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d);
const oneOrNull = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);

/** Settings from a stored object: anything missing or broken takes the default. */
export function parseSettings(o: unknown): Settings {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    master: num01(r.master, d.master),
    sfx: num01(r.sfx, d.sfx),
    music: num01(r.music, d.music),
    muted: typeof r.muted === 'boolean' ? r.muted : d.muted,
    mapStyle: oneOrNull(MAP_STYLE_WORDS, r.mapStyle),
    art: oneOrNull(ART_STYLES, r.art),
    motion: oneOrNull(MOTION_PRESETS, r.motion),
    effects: typeof r.effects === 'boolean' ? r.effects : d.effects,
    reduceMotion: oneOf(REDUCE, r.reduceMotion, d.reduceMotion),
    quality: oneOf(QUALITIES, r.quality, d.quality),
  };
}

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

function read(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function json(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The settings the old keys hold (the sound volumes, the map look, the map effects switch), else the defaults. */
export function migrateLegacy(store: KeyValueStore): Settings {
  const s = parseSettings(null);
  const v2 = json(read(store, AUDIO_STORAGE_KEY));
  const v1 = v2 ? null : read(store, LEGACY_AUDIO_STORAGE_KEY);
  if (v2 || v1) {
    const a = v2 ? parseAudioSettings(v2) : migrateAudioSettings(json(v1));
    s.master = a.master;
    s.sfx = a.sfx;
    s.music = a.music;
    s.muted = a.muted;
  }
  const look = (read(store, LEGACY_MAP_STYLE_KEY) ?? '').trim().toLowerCase();
  // the old key held a style name (the default was not stored); words from older builds map like mapStyle.ts did
  const alias: Record<string, MapStyle> = { a: 'pixel', b: 'muted', c: 'ground', classic: 'today', default: 'today' };
  s.mapStyle = oneOrNull(MAP_STYLE_WORDS, look) ?? alias[look] ?? null;
  if (read(store, LEGACY_FX_KEY) === 'off') s.effects = false;
  return s;
}

/** The saved settings; with none saved yet, the old keys' settings. */
export function loadSettings(store: KeyValueStore | null): Settings {
  if (!store) return parseSettings(null);
  const raw = read(store, FA_SETTINGS_KEY);
  if (raw !== null) return parseSettings(json(raw));
  return migrateLegacy(store);
}

export function saveSettings(store: KeyValueStore | null, s: Settings): void {
  try {
    store?.setItem(FA_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode or full: the settings last for this page only */
  }
}

// ------------------------------------------------------------------------------------------------ the live settings

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

let storage: KeyValueStore | null | undefined;
let current: Settings | null = null;
let version = 0;
const listeners = new Set<(changed: readonly SettingKey[]) => void>();

function live(): Settings {
  if (current) return current;
  if (storage === undefined) storage = browserStore();
  const migrating = !!storage && read(storage, FA_SETTINGS_KEY) === null;
  current = loadSettings(storage);
  // once moved over, the settings live under the new key
  if (migrating) saveSettings(storage, current);
  return current;
}

/** The settings now (do not change the object: use setSetting). */
export function getSettings(): Readonly<Settings> {
  return live();
}

/** Changes one setting: saved at once, then every listener hears which keys changed. */
export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  const s = live();
  const next = parseSettings({ ...s, [key]: value });
  if (next[key] === s[key]) return;
  current = next;
  version++;
  saveSettings(storage ?? null, next);
  notify([key]);
}

/** Puts these settings back to their defaults (a section's "Reset to defaults"). */
export function resetSettings(keys: readonly SettingKey[]): void {
  const s = { ...live() } as Record<SettingKey, unknown>;
  const changed: SettingKey[] = [];
  for (const k of keys) {
    if (s[k] === DEFAULT_SETTINGS[k]) continue;
    s[k] = DEFAULT_SETTINGS[k];
    changed.push(k);
  }
  if (!changed.length) return;
  current = parseSettings(s);
  version++;
  saveSettings(storage ?? null, current);
  notify(changed);
}

/** Calls `fn` after every change with the keys that changed. Returns a remover. */
export function onSettingsChange(fn: (changed: readonly SettingKey[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Changes whenever a setting changes. */
export function settingsVersion(): number {
  return version;
}

function notify(keys: readonly SettingKey[]): void {
  for (const fn of [...listeners]) {
    try {
      fn(keys);
    } catch (err) {
      console.warn('settings listener failed', err);
    }
  }
}

/** Tests: use this store (null = none, undefined = the browser's) and load again from it. */
export function useSettingsStorage(store: KeyValueStore | null | undefined): void {
  storage = store;
  current = null;
  version++;
}
