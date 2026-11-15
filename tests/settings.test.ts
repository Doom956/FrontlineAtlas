// The settings store (src/client/settings/store.ts): defaults, saving and loading, broken values, the move from the
// keys each part used to keep (sound volumes, map look, map effects), section resets, and the parts that read it
// (map look, map effects, reduce motion, graphics quality).
import { beforeEach, describe, expect, it } from 'vitest';
import { AUDIO_STORAGE_KEY, LEGACY_AUDIO_STORAGE_KEY } from '../src/client/audio';
import { FX_STORAGE_KEY, fxEnabled, prefersReducedMotion, setFxEnabled } from '../src/client/fx/settings';
import { liteWanted } from '../src/client/render/glmap';
import { buildMapStyle, MAP_STYLE_KEY, mapStyle, mapStyleVersion, setMapStyle } from '../src/client/render/mapStyle';
import {
  DEFAULT_SETTINGS,
  DISPLAY_KEYS,
  FA_SETTINGS_KEY,
  getSettings,
  LEGACY_FX_KEY,
  LEGACY_MAP_STYLE_KEY,
  loadSettings,
  migrateLegacy,
  onSettingsChange,
  parseSettings,
  resetSettings,
  setSetting,
  SOUND_KEYS,
  useSettingsStorage,
} from '../src/client/settings/store';

class MemStore {
  map = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.writes++;
    this.map.set(k, String(v));
  }
}

let mem: MemStore;
beforeEach(() => {
  mem = new MemStore();
  useSettingsStorage(mem);
});

describe('settings store', () => {
  it('starts on the defaults with nothing saved, or with no storage at all', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ master: 0.6, sfx: 0.8, music: 0.5, muted: false, mapStyle: null, art: null, motion: null, effects: true, reduceMotion: 'device', quality: 'auto' });
    useSettingsStorage(null);
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    setSetting('master', 0.2);
    expect(getSettings().master).toBe(0.2);
  });

  it('saves every change at once and loads it back', () => {
    setSetting('music', 0.25);
    setSetting('quality', 'low');
    setSetting('mapStyle', 'today');
    const saved = JSON.parse(mem.getItem(FA_SETTINGS_KEY)!);
    expect(saved).toMatchObject({ music: 0.25, quality: 'low', mapStyle: 'today' });
    useSettingsStorage(mem);
    expect(getSettings()).toMatchObject({ music: 0.25, quality: 'low', mapStyle: 'today', master: DEFAULT_SETTINGS.master });
    expect(loadSettings(mem).quality).toBe('low');
  });

  it('takes the default for anything missing or broken', () => {
    const s = parseSettings({ master: 7, sfx: 'loud', music: -1, muted: 'yes', mapStyle: 'nope', art: 'realistic', motion: 'wild', effects: 0, reduceMotion: 'on', quality: 'ultra' });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, master: 1, music: 0, art: 'realistic', reduceMotion: 'on' });
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    mem.setItem(FA_SETTINGS_KEY, '{not json');
    useSettingsStorage(mem);
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    // a bad value from code is refused too
    setSetting('quality', 'ultra' as never);
    expect(getSettings().quality).toBe('auto');
  });

  it("moves today's keys over: the sound volumes, the map look and the map effects switch", () => {
    mem.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ master: 0.3, sfx: 0.4, music: 0.1, muted: true }));
    mem.setItem(MAP_STYLE_KEY, 'today');
    mem.setItem(FX_STORAGE_KEY, 'off');
    expect(LEGACY_MAP_STYLE_KEY).toBe(MAP_STYLE_KEY);
    expect(LEGACY_FX_KEY).toBe(FX_STORAGE_KEY);
    expect(getSettings()).toMatchObject({ master: 0.3, sfx: 0.4, music: 0.1, muted: true, mapStyle: 'today', effects: false });
    // moved once: now under the new key, the old keys left as they were
    expect(JSON.parse(mem.getItem(FA_SETTINGS_KEY)!)).toMatchObject({ master: 0.3, mapStyle: 'today', effects: false });
    expect(mem.getItem(AUDIO_STORAGE_KEY)).not.toBeNull();
    expect(mem.getItem(MAP_STYLE_KEY)).toBe('today');
    // a later change to an old key is not read again
    mem.setItem(MAP_STYLE_KEY, 'muted');
    useSettingsStorage(mem);
    expect(getSettings().mapStyle).toBe('today');
  });

  it('moves the version 1 sound settings (music turned on) and old map words', () => {
    mem.setItem(LEGACY_AUDIO_STORAGE_KEY, JSON.stringify({ master: 0.5, sfx: 0.9, music: 0, muted: false }));
    mem.setItem(MAP_STYLE_KEY, 'c');
    const s = migrateLegacy(mem);
    expect(s).toMatchObject({ master: 0.5, sfx: 0.9, music: DEFAULT_SETTINGS.music, mapStyle: 'ground', effects: true });
    // nothing old: the defaults
    expect(migrateLegacy(new MemStore())).toEqual(DEFAULT_SETTINGS);
  });

  it('saved settings win over the old keys', () => {
    mem.setItem(FA_SETTINGS_KEY, JSON.stringify({ master: 0.9 }));
    mem.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ master: 0.1 }));
    useSettingsStorage(mem);
    expect(getSettings().master).toBe(0.9);
  });

  it('resets one section only, and tells the listeners which keys changed', () => {
    const heard: string[][] = [];
    const off = onSettingsChange((keys) => heard.push([...keys]));
    setSetting('master', 0.1);
    setSetting('muted', true);
    setSetting('quality', 'high');
    setSetting('quality', 'high'); // no change: no call
    resetSettings(SOUND_KEYS);
    expect(getSettings()).toMatchObject({ master: DEFAULT_SETTINGS.master, muted: false, quality: 'high' });
    expect(heard).toEqual([['master'], ['muted'], ['quality'], ['master', 'muted']]);
    resetSettings(DISPLAY_KEYS);
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    off();
    setSetting('sfx', 0.5);
    expect(heard).toHaveLength(5);
  });

  it('survives a storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    useSettingsStorage(bad);
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    setSetting('muted', true);
    expect(getSettings().muted).toBe(true);
  });
});

describe('parts that read the settings', () => {
  it('map look: a pick is saved, and the reset gives the build default', () => {
    const v = mapStyleVersion();
    setMapStyle('pixel');
    expect(mapStyle()).toBe('pixel');
    expect(getSettings().mapStyle).toBe('pixel');
    expect(mapStyleVersion()).toBeGreaterThan(v);
    resetSettings(DISPLAY_KEYS);
    expect(mapStyle()).toBe(buildMapStyle());
    expect(buildMapStyle()).toBe('ground');
  });

  it('map effects and reduce motion', () => {
    setFxEnabled(false);
    expect(fxEnabled()).toBe(false);
    expect(getSettings().effects).toBe(false);
    setFxEnabled(true);
    setSetting('reduceMotion', 'on');
    expect(prefersReducedMotion()).toBe(true);
    setSetting('reduceMotion', 'off');
    expect(prefersReducedMotion()).toBe(false);
  });

  it('graphics quality: Low always uses the light map, High never, Auto only without a graphics card', () => {
    expect(liteWanted(true, 'auto')).toBe(true);
    expect(liteWanted(false, 'auto')).toBe(false);
    expect(liteWanted(false, 'low')).toBe(true);
    expect(liteWanted(true, 'high')).toBe(false);
    setSetting('quality', 'low');
    expect(liteWanted(false)).toBe(true);
  });
});
